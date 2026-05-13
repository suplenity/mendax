'use strict';

const {
  app, BrowserWindow, ipcMain,
  Tray, Menu, nativeImage,
  screen: electronScreen
} = require('electron');
const path   = require('path');
const { exec, spawn } = require('child_process');
const fs     = require('fs');
const zlib   = require('zlib');
const https  = require('https');

const DiscordCDP = require('./src/discord-cdp');
const Scripts    = require('./src/quest-scripts');

// ─── Globals ──────────────────────────────────────────────────────────────────

let win              = null;
let cdp              = null;
let progressInterval = null;
let discordWatchInterval = null;
let tray             = null;
let currentNotifWin  = null;
let currentTheme     = 'blue';
let isReconnecting   = false;

// ─── PNG Builder (tray icon — no external deps) ───────────────────────────────

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePNG(w, h, r, g, b) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3]     = r;
      raw[off + 1 + x * 3 + 1] = g;
      raw[off + 1 + x * 3 + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);

  function chunk(type, data) {
    const t   = Buffer.from(type, 'ascii');
    const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
    const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, colour type RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  try {
    const icon = nativeImage.createFromBuffer(makePNG(32, 32, 59, 130, 246));
    tray = new Tray(icon);
    tray.setToolTip('Mendax — Quest Completer');

    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Show Mendax',
        click: () => { if (win) { win.show(); win.focus(); } }
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));

    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
    log('info', 'system tray created');
  } catch (e) {
    log('warn', 'tray creation failed: ' + e.message);
  }
}

// ─── Custom Notifications ─────────────────────────────────────────────────────

function showNotification(type, title, body) {
  try {
    if (currentNotifWin && !currentNotifWin.isDestroyed()) {
      currentNotifWin.close();
      currentNotifWin = null;
    }

    const { width, height } = electronScreen.getPrimaryDisplay().workAreaSize;
    const W = 320, H = 90, M = 14;

    const notifWin = new BrowserWindow({
      width: W, height: H,
      x: width  - W - M,
      y: height - H - M,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    notifWin.loadFile(
      path.join(__dirname, 'renderer', 'notification.html'),
      { query: { type, title, body, theme: currentTheme } }
    );

    currentNotifWin = notifWin;

    const autoClose = setTimeout(() => {
      if (!notifWin.isDestroyed()) notifWin.close();
    }, 5000);

    notifWin.on('closed', () => {
      clearTimeout(autoClose);
      if (currentNotifWin === notifWin) currentNotifWin = null;
    });
  } catch (e) {
    log('warn', 'showNotification error: ' + e.message);
  }
}

// ─── Sounds ───────────────────────────────────────────────────────────────────

function playSound(type) {
  // Plays via the hidden main window renderer (always alive, even when in tray)
  if (win && !win.isDestroyed()) {
    win.webContents.send('play-sound', { type });
  }
}

// ─── Discord Process Management ───────────────────────────────────────────────

function isDiscordRunning() {
  return new Promise(resolve => {
    exec('tasklist /FI "IMAGENAME eq Discord.exe" /NH', (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.toLowerCase().includes('discord.exe'));
    });
  });
}

function killDiscord() {
  return new Promise(resolve => {
    exec('taskkill /F /IM Discord.exe /T', () => {
      exec('taskkill /F /IM DiscordCanary.exe /T', () => {
        exec('taskkill /F /IM DiscordPTB.exe /T', () => {
          setTimeout(resolve, 1500);
        });
      });
    });
  });
}

function findDiscordExe() {
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    { dir: path.join(localAppData, 'Discord'),      exe: 'Discord.exe' },
    { dir: path.join(localAppData, 'DiscordCanary'), exe: 'DiscordCanary.exe' },
    { dir: path.join(localAppData, 'DiscordPTB'),   exe: 'DiscordPTB.exe' }
  ];
  for (const { dir, exe } of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const appFolders = fs.readdirSync(dir).filter(f => f.startsWith('app-')).sort();
      if (appFolders.length === 0) continue;
      const exePath = path.join(dir, appFolders[appFolders.length - 1], exe);
      if (fs.existsSync(exePath)) { log('debug', `found discord exe: ${exePath}`); return exePath; }
    } catch {}
  }
  return null;
}

function launchDiscordWithDebugPort(exePath) {
  return new Promise((resolve, reject) => {
    log('info', `launching discord with debug port: ${exePath}`);
    const proc = spawn(exePath, ['--remote-debugging-port=9222'], {
      detached: true, stdio: 'ignore'
    });
    proc.unref();

    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      const tmp = new DiscordCDP(() => {});
      const port = await tmp.findPort();
      if (port) { clearInterval(check); log('info', 'discord debug port ready'); resolve(); }
      else if (attempts >= 30) { clearInterval(check); reject(new Error('discord took too long to start')); }
    }, 1500);
  });
}

// ─── Discord Connection Sequence ──────────────────────────────────────────────

async function connectToDiscord() {
  send('prep:step', { step: 'checking-discord', label: 'checking discord status...' });

  const running = await isDiscordRunning();
  if (!running) { send('discord:offline', {}); log('warn', 'discord is not running'); return false; }

  log('info', 'discord is running');
  send('prep:step', { step: 'finding-port', label: 'looking for debug port...' });

  const tempCdp = new DiscordCDP(m => log('debug', m));
  const port    = await tempCdp.findPort();

  if (!port) {
    send('prep:warn', { step: 'relaunch', label: 'no debug port found — discord will restart once to enable it' });
    log('info', 'no debug port found — relaunching discord with debug port');

    const exePath = findDiscordExe();
    if (!exePath) {
      send('prep:error', { msg: 'could not find discord executable. please launch discord manually.' });
      log('error', 'discord executable not found');
      return false;
    }

    await killDiscord();
    log('info', 'killed existing discord processes');
    send('prep:step', { step: 'relaunch-wait', label: 'waiting for discord to restart...' });

    try {
      await launchDiscordWithDebugPort(exePath);
    } catch (e) {
      send('prep:error', { msg: e.message });
      log('error', 'failed to relaunch discord: ' + e.message);
      return false;
    }
  } else {
    log('info', 'debug port already open');
  }

  send('prep:step', { step: 'connecting', label: 'connecting to discord...' });

  if (cdp) { cdp.disconnect(); cdp = null; }
  cdp = new DiscordCDP(m => log('debug', m));

  try {
    await cdp.connect();
  } catch (e) {
    send('prep:error', { msg: 'cdp connection failed: ' + e.message });
    log('error', 'cdp connect failed: ' + e.message);
    return false;
  }

  const MAX_ATTEMPTS = 8, RETRY_MS = 2500;
  let setupResult = null;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const label = `waiting for discord modules... (${i + 1}/${MAX_ATTEMPTS})`;
    send('prep:step', { step: 'injecting', label });
    log('info', label);

    try {
      const raw    = await cdp.evalString(Scripts.SETUP);
      const result = JSON.parse(raw);
      if (result.ok) { setupResult = result; break; }
      log('debug', `attempt ${i + 1} — modules not ready: ${JSON.stringify(result.found)}`);
    } catch (e) {
      log('debug', `attempt ${i + 1} — eval error: ${e.message}`);
    }

    if (i < MAX_ATTEMPTS - 1) await delay(RETRY_MS);
  }

  if (!setupResult || !setupResult.ok) {
    send('prep:error', { msg: 'discord did not finish loading. please fully relaunch discord and try again.' });
    log('error', 'discord modules never became available');
    return false;
  }

  log('info', 'modules loaded: ' + JSON.stringify(setupResult.found));
  send('prep:step', { step: 'injecting', label: 'discord modules ready.' });
  startDiscordWatch();
  return true;
}

// ─── Discord Activity Proxy ───────────────────────────────────────────────────

// Mirrors questify's native.ts approach:
//   authorize: POST /.proxy/acf/authorize { code } → { token }
//   progress:  POST /.proxy/acf/quest/progress { progress: N } with x-auth-token header
function discordSaysPost(appId, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts = {
      hostname: appId + '.discordsays.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'application/json, */*',
        'Origin': 'https://' + appId + '.discordsays.com',
        'Referer': 'https://' + appId + '.discordsays.com/',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Dest': 'empty',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9170 Chrome/132.0.6834.210 Electron/34.3.0 Safari/537.36',
        ...extraHeaders
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Quest Fetching ───────────────────────────────────────────────────────────

async function fetchQuests() {
  if (!cdp || !cdp.isAlive()) { send('prep:error', { msg: 'not connected to discord' }); return; }

  send('prep:step', { step: 'quests', label: 'fetching quest data...' });
  log('info', 'fetching quests');

  try {
    const raw    = await cdp.evalString(Scripts.GET_QUESTS);
    const result = JSON.parse(raw);
    if (!result.ok) {
      log('error', 'quest fetch failed: ' + result.error);
      send('prep:warn', { step: 'quests', label: 'refresh failed — showing last known quests' });
      return; // keep existing quest list in the UI
    }
    log('info', `found ${result.quests.length} active quest(s)`);
    send('quests:list', { quests: result.quests });
  } catch (e) {
    log('error', 'quest fetch threw: ' + e.message);
    send('prep:warn', { step: 'quests', label: 'refresh failed — showing last known quests' });
    // keep existing quest list in the UI
  }
}

// ─── Quest Execution ──────────────────────────────────────────────────────────

async function startQuest(quest) {
  if (!cdp || !cdp.isAlive()) { send('quest:error', { msg: 'not connected to discord' }); return; }

  log('info', `starting quest: "${quest.questName}" | type: ${quest.taskName}`);

  let script;
  try {
    script = Scripts.buildQuestScript(quest);
  } catch (e) {
    send('quest:error', { msg: e.message });
    log('error', 'script build failed: ' + e.message);
    return;
  }

  try {
    await cdp.inject(script);
    log('info', 'quest script injected — monitoring progress');
  } catch (e) {
    send('quest:error', { msg: 'injection failed: ' + e.message });
    log('error', 'inject error: ' + e.message);
    return;
  }

  await delay(800);
  if (quest.taskName === 'ACHIEVEMENT_IN_ACTIVITY') {
    startActivityAchievementLoop(quest);
  } else {
    startProgressPolling(quest);
  }
}

async function stopQuest() {
  stopProgressPolling();
  if (cdp && cdp.isAlive()) {
    try { await cdp.evalString(Scripts.STOP_QUEST); log('info', 'quest stopped by user'); }
    catch (e) { log('warn', 'stop signal error: ' + e.message); }
  }
}

async function enrollQuest(questId) {
  if (!cdp || !cdp.isAlive()) return { ok: false, error: 'not connected to discord' };
  try {
    const raw = await cdp.evalStringAsync(Scripts.buildEnrollScript(questId));
    const result = JSON.parse(raw);
    if (result.ok) log('info', `enrolled in quest: ${questId}`);
    else log('warn', `enroll failed for ${questId}: ${result.error}`);
    return result;
  } catch(e) {
    log('error', 'enrollQuest threw: ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ─── Progress Polling ─────────────────────────────────────────────────────────

function startProgressPolling(quest) {
  stopProgressPolling();
  log('debug', 'progress polling started');

  progressInterval = setInterval(async () => {
    if (!cdp || !cdp.isAlive()) { stopProgressPolling(); return; }

    try {
      const raw = await cdp.evalString(Scripts.GET_STATE);
      if (!raw || raw === 'null') return;

      const state = JSON.parse(raw);
      log('debug', `progress: ${state.secondsDone}/${state.secondsNeeded}s | running: ${state.running} | completed: ${state.completed}`);

      send('progress:update', {
        secondsDone:   state.secondsDone,
        secondsNeeded: state.secondsNeeded,
        percent:       Math.min(100, Math.floor((state.secondsDone / state.secondsNeeded) * 100)),
        running:       state.running,
        completed:     state.completed,
        error:         state.error,
        appName:       state.appName,
        taskName:      state.taskName
      });

      if (state.error) {
        log('error', 'quest error: ' + state.error);
        showNotification('error', 'Quest Error', state.error);
        playSound('error');
      }

      if (state.completed) {
        log('info', `quest "${quest.questName}" completed!`);
        stopProgressPolling();
        showNotification('complete', 'Quest Complete', quest.questName);
        playSound('complete');
        send('quest:complete', { questName: quest.questName });
      } else if (!state.running && !state.completed) {
        log('info', 'quest stopped (not running, not completed)');
        stopProgressPolling();
        send('quest:stopped', {});
      }
    } catch (e) {
      log('warn', 'progress poll error: ' + e.message);
    }
  }, 1000);
}

function stopProgressPolling() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
    log('debug', 'progress polling stopped');
  }
}

// ─── Activity Achievement Loop ────────────────────────────────────────────────
// Mirrors questify native.ts exactly:
//   1. Renderer gets OAuth2 code via POST /oauth2/authorize (Discord internal API)
//   2. Main process POSTs /.proxy/acf/authorize { code } → JWT token in body
//   3. Main process POSTs /.proxy/acf/quest/progress { progress: target } with x-auth-token
//      — sends the full target in one shot, same as questify.
//   4. Renderer deauths the OAuth token when done (cleanup).

async function startActivityAchievementLoop(quest) {
  log('info', 'ACHIEVEMENT_IN_ACTIVITY — waiting for OAuth2 code from renderer...');
  startProgressPolling(quest);

  const appId  = quest.activityAppId;
  const target = quest.secondsNeeded;

  // ── Step 1: wait for renderer to set authCode on __ppState__ ─────────────────
  let authCode = null;
  for (let i = 0; i < 30; i++) {
    await delay(600);
    if (!cdp || !cdp.isAlive()) { send('quest:error', { msg: 'disconnected' }); return; }
    try {
      const raw = await cdp.evalString(Scripts.GET_STATE);
      if (!raw || raw === 'null') continue;
      const state = JSON.parse(raw);
      if (state.error) { send('quest:error', { msg: state.error }); log('error', 'achievement script: ' + state.error); return; }
      if (state.authCode) { authCode = state.authCode; log('info', 'oauth2 auth code received'); break; }
    } catch(e) { log('warn', 'state poll: ' + e.message); }
  }

  if (!authCode) {
    send('quest:error', { msg: 'could not get OAuth2 code for activity — discord may have rejected the authorization' });
    log('error', 'no authCode after 18s');
    return;
  }

  // ── Step 2: exchange auth code for JWT token via /.proxy/acf/authorize ────────
  log('info', `authorizing with /.proxy/acf/authorize...`);
  let token = null;
  try {
    const res = await discordSaysPost(appId, '/.proxy/acf/authorize', { code: authCode });
    token = res.body?.token ?? null;
    if (!token) throw new Error('no token in response: ' + JSON.stringify(res.body).slice(0, 200));
    log('info', 'jwt token obtained');
  } catch(e) {
    send('quest:error', { msg: 'authorize failed: ' + e.message });
    log('error', 'authorize: ' + e.message);
    await cdp.evalString(`if(window.__ppState__){window.__ppState__.error=${JSON.stringify(e.message)};window.__ppState__.running=false;}`).catch(() => {});
    return;
  }

  // ── Step 3: send full progress in one shot ────────────────────────────────────
  log('info', `sending progress ${target}/${target}...`);
  try {
    const res = await discordSaysPost(appId, '/.proxy/acf/quest/progress', { progress: target }, { 'x-auth-token': token });
    if (res.status === 200 || res.status === 204) {
      log('info', 'achievement progress accepted — quest complete');
      await cdp.evalString(
        `(function(){if(!window.__ppState__)return;window.__ppState__.secondsDone=${target};window.__ppState__.completed=true;window.__ppState__.running=false;})()`
      ).catch(() => {});
    } else {
      const msg = `progress POST returned ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`;
      log('error', msg);
      await cdp.evalString(`if(window.__ppState__){window.__ppState__.error=${JSON.stringify(msg)};window.__ppState__.running=false;}`).catch(() => {});
    }
  } catch(e) {
    log('error', 'progress POST error: ' + e.message);
    await cdp.evalString(`if(window.__ppState__){window.__ppState__.error=${JSON.stringify(e.message)};window.__ppState__.running=false;}`).catch(() => {});
  }

  // ── Step 4: deauth the OAuth token (cleanup, best-effort) ────────────────────
  const deauthScript = `
(async function() {
  try {
    const { api } = window.__pp__;
    // AuthorizedAppsStore is not in our SETUP scan, so use the REST API directly.
    // GET /oauth2/tokens returns all authorized apps; find ours and delete it.
    const res = await api.get({ url: '/oauth2/tokens' });
    const token = (res.body || []).find(t => t.application?.id === ${JSON.stringify(appId)});
    if (token) await api.del({ url: '/oauth2/tokens/' + token.id });
  } catch(e) {}
})()`;
  await cdp.evalString(deauthScript).catch(() => {});
}

// ─── Discord Watch + Auto-Reconnect ───────────────────────────────────────────

function startDiscordWatch() {
  if (discordWatchInterval) clearInterval(discordWatchInterval);
  discordWatchInterval = setInterval(async () => {
    if (!cdp) return;
    if (!cdp.isAlive()) {
      log('warn', 'cdp connection lost — discord may have closed');
      handleDiscordDisconnect();
      return;
    }
    const running = await isDiscordRunning();
    if (!running) {
      log('warn', 'discord process not found — closed externally');
      handleDiscordDisconnect();
    }
  }, 4000);
}

function stopDiscordWatch() {
  if (discordWatchInterval) { clearInterval(discordWatchInterval); discordWatchInterval = null; }
}

async function handleDiscordDisconnect() {
  if (isReconnecting) return;
  isReconnecting = true;

  stopProgressPolling();
  stopDiscordWatch();
  if (cdp) { cdp.disconnect(); cdp = null; }

  log('warn', 'discord connection lost — attempting auto-reconnect');

  const MAX_ATTEMPTS = 3;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    send('discord:reconnecting', { attempt: i + 1, max: MAX_ATTEMPTS });
    log('info', `reconnect attempt ${i + 1}/${MAX_ATTEMPTS}...`);
    await delay(4000);

    const running = await isDiscordRunning();
    if (!running) { log('warn', `reconnect ${i + 1}: discord not running`); continue; }

    const tmp  = new DiscordCDP(m => log('debug', m));
    const port = await tmp.findPort();
    if (!port) { log('warn', `reconnect ${i + 1}: no debug port found`); continue; }

    try {
      cdp = new DiscordCDP(m => log('debug', m));
      await cdp.connect();
      log('info', 'reconnected to discord successfully');
      isReconnecting = false;
      send('discord:reconnected', {});
      send('quest:stopped', {}); // any in-progress quest is dead
      startDiscordWatch();
      return;
    } catch (e) {
      log('warn', `reconnect ${i + 1} failed: ${e.message}`);
      if (cdp) { cdp.disconnect(); cdp = null; }
    }
  }

  isReconnecting = false;
  log('error', 'all reconnect attempts failed — closing');
  send('discord:disconnected', {});
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('discord:connect', async () => {
  log('info', '--- connection sequence started ---');
  const ok = await connectToDiscord();
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
  if (ok) await fetchQuests();
  return ok;
});

ipcMain.handle('discord:refresh-quests', async () => { await fetchQuests(); });

ipcMain.handle('discord:start-quest',    async (_e, quest) => { await startQuest(quest); });

ipcMain.handle('discord:stop-quest',     async () => { await stopQuest(); });

ipcMain.handle('discord:enroll-quest',   async (_e, questId) => enrollQuest(questId));

ipcMain.handle('discord:check-running',  async () => isDiscordRunning());

// Minimize → normal OS minimize
ipcMain.on('window:minimize', () => { if (win) win.minimize(); });

// Tray button → hide to system tray
ipcMain.on('window:tray', () => { if (win) win.hide(); });;

// Close → quit
ipcMain.on('window:close', () => { app.quit(); });

// Track current theme for notifications
ipcMain.on('app:set-theme', (_e, theme) => { currentTheme = theme; });

// ─── App Bootstrap ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 900,
    minHeight: 700,
    maxWidth: 900,
    maxHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: '#06080f',
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    stopProgressPolling();
    stopDiscordWatch();
    if (cdp) { cdp.disconnect(); cdp = null; }
    win = null;
  });

  createTray();
});

app.on('window-all-closed', () => {
  // Don't quit when main window closes — tray keeps app alive
  // Quit is handled by tray context menu or X button
});
