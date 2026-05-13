'use strict';

const http = require('http');
const WebSocket = require('ws');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
    });
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

class DiscordCDP {
  constructor(log) {
    this.log = log || (() => {});
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.port = null;
    this.connected = false;
  }

  async findPort() {
    for (const p of [9222, 9223, 9224, 9225]) {
      try {
        await httpGet(`http://localhost:${p}/json/version`);
        this.log(`debug port found at ${p}`);
        return p;
      } catch {}
    }
    return null;
  }

  async connect() {
    const port = await this.findPort();
    if (!port) throw new Error('no debug port open');

    this.port = port;
    this.log(`connecting to CDP on port ${port}...`);

    // Discord has several CDP targets (main process, updater, etc.).
    // We must attach to the actual renderer page that runs the Discord web UI —
    // identified by a discord.com URL. Poll until that target appears.
    let target = null;
    for (let i = 0; i < 40; i++) {
      let pages;
      try { pages = await httpGet(`http://localhost:${port}/json`); } catch { pages = []; }

      this.log(`scanning ${pages.length} CDP target(s)...`);
      pages.forEach(p => this.log(`  target: [${p.type}] "${p.title}" — ${p.url}`));

      // Prefer the main Discord app page
      target =
        pages.find(p => p.type === 'page' && p.url && p.url.includes('discord.com/channels')) ||
        pages.find(p => p.type === 'page' && p.url && p.url.includes('discord.com/app')) ||
        pages.find(p => p.type === 'page' && p.url && p.url.includes('discord.com/login')) ||
        pages.find(p => p.type === 'page' && p.url && p.url.includes('discord.com'));

      if (target) break;
      this.log(`discord.com page target not found yet, waiting... (${i + 1}/40)`);
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!target) throw new Error('no Discord page target found — Discord may not have finished loading');

    this.log(`attaching to target: ${target.url || target.title}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(target.webSocketDebuggerUrl);

      this.ws.on('open', () => {
        this.connected = true;
        this.log('CDP WebSocket connected');
        resolve();
      });

      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      });

      this.ws.on('error', (e) => {
        this.connected = false;
        if (this.pending.size > 0) {
          this.pending.forEach(({ reject }) => reject(e));
          this.pending.clear();
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.pending.forEach(({ reject }) => reject(new Error('CDP connection closed')));
        this.pending.clear();
      });

      setTimeout(() => {
        if (!this.connected) reject(new Error('CDP connect timeout'));
      }, 8000);
    });
  }

  async evaluate(expression) {
    if (!this.connected || !this.ws) throw new Error('not connected');
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: false,
          userGesture: true
        }
      }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('evaluate timeout'));
        }
      }, 10000);
    });
  }

  // For fire-and-forget injections (quest scripts run in background inside Discord)
  async inject(expression) {
    if (!this.connected || !this.ws) throw new Error('not connected');
    const id = ++this.msgId;
    this.ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: false, awaitPromise: false, userGesture: true }
    }));
  }

  async evalString(expression) {
    const result = await this.evaluate(expression);
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    }
    return result?.result?.value;
  }

  // Like evalString but waits for the Promise to settle (for async IIFEs)
  async evalStringAsync(expression, timeoutMs = 15000) {
    if (!this.connected || !this.ws) throw new Error('not connected');
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        }
      }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('evalStringAsync timeout'));
        }
      }, timeoutMs);
    }).then(result => {
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      }
      return result?.result?.value;
    });
  }

  async sendCommand(method, params = {}) {
    if (!this.connected || !this.ws) throw new Error('not connected');
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 10000);
    });
  }

  async getCookies(url) {
    const result = await this.sendCommand('Network.getCookies', { urls: [url] });
    return result?.cookies || [];
  }

  disconnect() {
    this.connected = false;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  isAlive() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

module.exports = DiscordCDP;
