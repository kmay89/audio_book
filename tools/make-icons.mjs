// Regenerate the PWA icons with the stdlib only (zlib PNG writer, supersampled).
// Deep indigo ground, the series' spectral rule, and a paper play triangle.
// Usage: node tools/make-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4; // supersample factor

const SPECTRUM = [
  [0.00, [204, 51, 51]], [0.18, [221, 136, 0]], [0.33, [204, 170, 0]],
  [0.50, [51, 170, 51]], [0.67, [34, 136, 170]], [0.84, [51, 51, 204]], [1.00, [102, 51, 204]],
];
const lerp = (a, b, t) => a + (b - a) * t;
function spectrumAt(t){
  for (let i = 1; i < SPECTRUM.length; i++){
    if (t <= SPECTRUM[i][0]){
      const [t0, c0] = SPECTRUM[i - 1], [t1, c1] = SPECTRUM[i];
      const k = (t - t0) / (t1 - t0);
      return c0.map((c, j) => lerp(c, c1[j], k));
    }
  }
  return SPECTRUM.at(-1)[1];
}

function render(size, {pad = 0} = {}){
  const S = size * SS;
  const px = new Float64Array(S * S * 3);
  const cx = S / 2;
  const inner = S * (1 - pad); // content square
  for (let y = 0; y < S; y++){
    for (let x = 0; x < S; x++){
      const i = (y * S + x) * 3;
      // ground: vertical indigo gradient
      const t = y / S;
      px[i] = lerp(30, 22, t); px[i + 1] = lerp(30, 22, t); px[i + 2] = lerp(64, 42, t);
      // spectral rule near the bottom of the content square
      const ry0 = cx + inner * 0.30, ry1 = ry0 + Math.max(2 * SS, inner * 0.035);
      const rx0 = cx - inner * 0.30, rx1 = cx + inner * 0.30;
      if (y >= ry0 && y < ry1 && x >= rx0 && x < rx1){
        const c = spectrumAt((x - rx0) / (rx1 - rx0));
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
      }
      // play triangle, centered a touch above the rule
      const tx0 = cx - inner * 0.155, tx1 = cx + inner * 0.21;
      const ty = cx - inner * 0.06;
      const th = inner * 0.23;
      if (x >= tx0 && x <= tx1){
        const k = (x - tx0) / (tx1 - tx0);
        const half = th * (1 - k);
        if (Math.abs(y - ty) <= half){ px[i] = 251; px[i + 1] = 250; px[i + 2] = 247; }
      }
    }
  }
  // downsample
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++){
    for (let x = 0; x < size; x++){
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++){
        const i = ((y * SS + dy) * S + x * SS + dx) * 3;
        r += px[i]; g += px[i + 1]; b += px[i + 2];
      }
      const o = (y * size + x) * 3, n = SS * SS;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

function png(size, rgb){
  const crcTable = [];
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = buf => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++){
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-512.png', 512, {}],
  ['icon-192.png', 192, {}],
  ['apple-touch-icon.png', 180, {}],
  ['icon-maskable-512.png', 512, {pad: 0.18}],
];
for (const [name, size, opts] of targets){
  fs.writeFileSync(path.join(ROOT, name), png(size, render(size, opts)));
  console.log(name);
}
