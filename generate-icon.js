'use strict';
// Generates assets/icon.ico — run once before building, or via npm run build

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

// Is point (px,py) inside a rounded rect centered at (cx,cy) size (w×h) radius r?
function inRRect(px, py, cx, cy, w, h, r) {
  const dx = Math.max(0, Math.abs(px - cx) - (w / 2 - r));
  const dy = Math.max(0, Math.abs(py - cy) - (h / 2 - r));
  return Math.sqrt(dx * dx + dy * dy);  // distance from rounded corner — 0 means inside
}

// ─── Per-size PNG generator ───────────────────────────────────────────────────

function makePNG(size) {
  const w = size, h = size;
  const pixels = Buffer.alloc(w * h * 4);

  const cx = w / 2, cy = h / 2;
  // Rounded square that fills ~82% of the icon canvas
  const sqW = w * 0.82, sqH = h * 0.82;
  const sqR = w * 0.18;           // corner radius

  // Accent blue + dark background colours
  const BG  = [0x06, 0x08, 0x0f];
  const ACC = [0x3b, 0x82, 0xf6]; // #3b82f6

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;

      const dist  = inRRect(x + 0.5, y + 0.5, cx, cy, sqW, sqH, sqR);
      // dist <= 0 → fully inside; dist ∈ (0,1] → AA edge; dist > 1 → outside
      const alpha = Math.max(0, Math.min(1, 1 - dist));

      pixels[idx]     = Math.round(ACC[0] * alpha + BG[0] * (1 - alpha));
      pixels[idx + 1] = Math.round(ACC[1] * alpha + BG[1] * (1 - alpha));
      pixels[idx + 2] = Math.round(ACC[2] * alpha + BG[2] * (1 - alpha));
      pixels[idx + 3] = 255;
    }
  }

  // ── Build PNG ──────────────────────────────────────────────────────────────

  function chunk(type, data) {
    const typeB = Buffer.from(type, 'ascii');
    return Buffer.concat([
      u32be(data.length),
      typeB,
      data,
      u32be(crc32(Buffer.concat([typeB, data])))
    ]);
  }

  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(w, 0);
  IHDR.writeUInt32BE(h, 4);
  IHDR[8]  = 8;  // bit depth
  IHDR[9]  = 2;  // RGB (no alpha channel — solid icon)
  IHDR[10] = IHDR[11] = IHDR[12] = 0;

  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0);   // filter byte
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw.push(pixels[i], pixels[i + 1], pixels[i + 2]);
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),  // PNG signature
    chunk('IHDR', IHDR),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ─── ICO container ───────────────────────────────────────────────────────────

function makeIco(sizes) {
  const pngs = sizes.map(s => makePNG(s));
  const count = sizes.length;
  const headerBytes = 6 + count * 16;

  // Compute data offsets
  let offset = headerBytes;
  const entries = pngs.map((png, i) => {
    const e = { size: sizes[i], data: png, offset };
    offset += png.length;
    return e;
  });

  const parts = [];

  // ICONDIR header
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);       // reserved
  dir.writeUInt16LE(1, 2);       // type: 1 = icon
  dir.writeUInt16LE(count, 4);   // image count
  parts.push(dir);

  // ICONDIRENTRY for each image
  for (const e of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = e.size >= 256 ? 0 : e.size;  // 0 means 256
    entry[1] = e.size >= 256 ? 0 : e.size;
    entry[2] = 0;  // colorCount
    entry[3] = 0;  // reserved
    entry.writeUInt16LE(1,  4);              // planes
    entry.writeUInt16LE(32, 6);              // bit count
    entry.writeUInt32LE(e.data.length, 8);  // bytes in resource
    entry.writeUInt32LE(e.offset,      12); // offset from start of file
    parts.push(entry);
  }

  for (const e of entries) parts.push(e.data);
  return Buffer.concat(parts);
}

// ─── Write ───────────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const ico = makeIco([16, 32, 48, 256]);
const outPath = path.join(outDir, 'icon.ico');
fs.writeFileSync(outPath, ico);
console.log(`✓ Generated ${outPath} (${ico.length} bytes, 4 sizes: 16/32/48/256)`);
