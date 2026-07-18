// Regenerate og-image.png (1200×630 share card) by screenshotting a crafted
// page in headless Chromium. Needs playwright (npm i playwright) — dev-only;
// the site itself stays dependency-free.
// Usage: node tools/make-og.mjs [chromium-executable-path]

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {chromium} = await import('playwright');

const html = `<!doctype html><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:linear-gradient(160deg,#1c1c3a 0%,#16162a 60%,#141420 100%);color:#fbfaf7;
  display:flex;flex-direction:column;justify-content:space-between;padding:56px 72px 0}
.top{display:flex;justify-content:space-between;align-items:baseline}
.eyebrow{font-size:22px;letter-spacing:.22em;text-transform:uppercase;color:#a9a9f0;font-weight:600}
.site{font-size:22px;color:#8a877e}
h1{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-size:72px;line-height:1.06;
  font-weight:700;letter-spacing:-.015em;margin-top:22px;max-width:1000px}
.sub{font-size:27px;color:#c9c6bc;margin-top:20px;max-width:760px;line-height:1.4}
.shelf{display:flex;gap:26px;align-items:flex-end;margin-top:10px}
.b{width:114px;height:170px;border-radius:7px;position:relative;box-shadow:0 14px 34px rgba(0,0,0,.45);
  display:flex;align-items:flex-end;padding:12px 12px 26px}
.b::after{content:"";position:absolute;left:12%;right:12%;bottom:7%;height:3px;border-radius:2px;
  background:linear-gradient(90deg,#e66,#ea3,#ec2,#5b5,#4ac,#66e,#a6e)}
.b span{font-family:Georgia,serif;font-weight:700;color:#fff;font-size:15px;line-height:1.25;text-shadow:0 1px 5px rgba(0,0,0,.5)}
.rule{height:6px;margin:34px -72px 0;background:linear-gradient(90deg,#c33,#d80,#ca0,#3a3,#28a,#33c,#63c)}
</style><body>
<div>
  <div class="top"><div class="eyebrow">The Everything Series · Karl Meves</div><div class="site">hear-my-book.com</div></div>
  <h1>Read it. Hear it. Keep your place.</h1>
  <div class="sub">A library you can read, hear, and see — free in your browser, with chapter-by-chapter audio.</div>
</div>
<div class="shelf">
  <div class="b" style="background:linear-gradient(150deg,#34346b,#5757c8)"><span>Everything That Glows</span></div>
  <div class="b" style="background:linear-gradient(150deg,#3a4a63,#52689a)"><span>Everything That Grows</span></div>
  <div class="b" style="background:linear-gradient(150deg,#4a3a86,#7458c8)"><span>Everything That Knows</span></div>
  <div class="b" style="background:linear-gradient(150deg,#8a5a12,#a8761f)"><span>Everything That Shows</span></div>
  <div class="b" style="background:linear-gradient(150deg,#1f5f5b,#2f8f88)"><span>Everything That Goes</span></div>
</div>
<div class="rule"></div>
</body>`;

const tmp = path.join(os.tmpdir(), 'og-' + process.pid + '.html');
fs.writeFileSync(tmp, html);
const browser = await chromium.launch({executablePath: process.argv[2] || undefined});
const page = await (await browser.newContext({viewport: {width: 1200, height: 630}, deviceScaleFactor: 1})).newPage();
await page.goto(pathToFileURL(tmp).href);
await page.screenshot({path: path.join(ROOT, 'og-image.png')});
await browser.close();
fs.rmSync(tmp);
console.log('og-image.png written (1200×630)');
