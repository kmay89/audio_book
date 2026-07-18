// End-to-end player suite. Composes a throwaway site dir from the repo +
// fixtures, serves it with byte-range support, and drives it in Chromium.
//
//   cd tests && npm install && node run.mjs
//
// CHROMIUM env var overrides the browser executable (e.g. a system install).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hmb-e2e-'));

// site files under test
for (const f of ['index.html', 'privacy.html', 'icon-192.png', 'icon-512.png', 'sw.js', 'manifest.webmanifest'])
  fs.copyFileSync(path.join(REPO, f), path.join(ROOT, f));
// fixtures
for (const f of ['catalog.test.json', 'text-sample.md'])
  fs.copyFileSync(path.join(TESTS, 'fixtures', f), path.join(ROOT, f));
fs.copyFileSync(path.join(REPO, 'icon-192.png'), path.join(ROOT, 'cover-test.png'));
// a 30s test tone as the audio fixture
{
  const rate = 8000, n = 30 * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF'); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(ROOT, 'test.wav'), Buffer.concat([hdr, data]));
}

// a minimal one-page PDF as the slide-deck fixture
fs.writeFileSync(path.join(ROOT, 'deck-test.pdf'), Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 150]>>endobj\n' +
  'trailer<</Root 1 0 R>>'));

const MIME = {'.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript',
  '.png': 'image/png', '.wav': 'audio/wav', '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json'};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath.slice(1));
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  const stat = fs.statSync(fp);
  const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = +range[1], end = range[2] ? +range[2] : stat.size - 1;
    res.writeHead(206, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1});
    fs.createReadStream(fp, {start, end}).pipe(res);
  } else {
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Content-Length': stat.size, 'Accept-Ranges': 'bytes'});
    fs.createReadStream(fp).pipe(res);
  }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}/index.html?catalog=catalog.test.json`;

let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failures++; };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// 1. library renders
await page.goto(BASE);
await page.waitForSelector('.cover');
ok(await page.locator('.cover').count() === 3, 'shelf shows 3 covers');
ok((await page.locator('.cover .cov-s').first().textContent()).includes('3 episodes'), 'episode count includes extras');
ok((await page.locator('.cover').nth(2).locator('.cov-s').textContent()).includes('1 episode'), 'unpublished book with preview shows episode count');
ok(await page.locator('.cover').nth(1).locator('.cov-badge').count() === 0, 'published book has no badge');
ok(await page.locator('#journey-slot .journey').count() === 0, 'no journey card before any listening');
ok(await page.locator('footer .ftr-links a[href="privacy.html"]').count() === 1, 'footer links to privacy');
ok(await page.locator('footer .ftr-links a[href="legal.html"]').count() === 1, 'footer links to legal');

// 1b. display settings: theme + text size persist
await page.locator('#btn-aa').click();
await page.locator('[data-theme-set="warm"]').click();
ok(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'warm', 'warm theme applies');
await page.locator('[data-size-set="l"]').click();
ok(await page.evaluate(() => document.documentElement.getAttribute('data-textsize')) === 'l', 'text size L applies');
await page.reload();
await page.waitForSelector('.cover');
ok(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'warm', 'theme persists (pre-paint)');
ok(await page.evaluate(() => document.documentElement.getAttribute('data-textsize')) === 'l', 'text size persists (pre-paint)');
await page.locator('#btn-aa').click();
await page.locator('[data-theme-set="auto"]').click();
await page.locator('[data-size-set="m"]').click();
ok(await page.evaluate(() => !document.documentElement.hasAttribute('data-theme') && !document.documentElement.hasAttribute('data-textsize')), 'auto/M clears overrides');
await page.keyboard.press('Escape');

// 2. open book (cover-open animation), chapter list + description + links
await page.locator('.cover').first().click();
await page.waitForSelector('#view-book.active', {timeout: 5000});
ok(await page.locator('#bk-chapters .row').count() === 3, 'book shows 3 chapters');
ok((await page.locator('#bk-desc').textContent()).includes('information is physical'), 'book description shown in book view');
ok((await page.locator('#bk-epub').getAttribute('href')).includes('everything-that-glows.epub'), 'EPUB link present in book view');
ok((await page.locator('#bk-read').getAttribute('href')).includes('everythingthatglows.com'), 'read-online link present in book view');
ok(await page.locator('#bk-epub').getAttribute('target') === '_blank', 'EPUB opens in new tab (audio keeps playing)');
await page.locator('#bk-feed').click();
await page.waitForSelector('#menu-feed.open', {timeout: 5000});
ok(await page.locator('#menu-feed [data-copy]').count() === 1, 'podcast menu offers Copy feed URL');
ok((await page.locator('#menu-feed button').allTextContents()).includes('Pocket Casts'), 'podcast menu offers a native app');
ok((await page.locator('#menu-feed [data-copy]').getAttribute('data-copy')).endsWith('feed-glows.xml'), 'feed URL points at the book feed');
await page.keyboard.press('Escape');
ok(await page.locator('#bk-extras .row').count() === 1, 'overview extra listed');
ok(await page.locator('#bk-chapters .row.noaudio').count() === 1, 'text-only chapter marked');
ok((await page.locator('#bk-chapters .row .sub').first().textContent()).includes('0:30'), 'duration shown');

// 3. outline + slides
await page.locator('[data-act="outline"]').first().click();
ok(await page.locator('.outline.open').isVisible(), 'outline expands');
await page.locator('[data-act="slides"]').first().click();
await page.waitForSelector('#slides-overlay.open');
ok(await page.locator('#slides-body .sv-slide img').count() === 2, 'slides modal shows page images');
ok((await page.locator('#slides-body .sv-count').textContent()) === '1 of 2', 'slide counter starts at 1');
ok(await page.locator('#slides-body .sv-deck a').count() === 1, 'deck download link under pager');
await page.locator('#slides-close').click();
// a pdf-only deck (not yet rasterized) embeds an inline viewer on fine pointers
await page.locator('[data-act="slides"]').nth(1).click();
await page.waitForSelector('#slides-overlay.open');
ok(await page.locator('#slides-body iframe.sv-pdf').count() === 1, 'pdf-only deck embeds inline viewer');
await page.locator('#slides-close').click();

// 4. play chapter 1, audio advances
await page.locator('#bk-chapters .row [data-act="play"]').first().click();
await page.waitForSelector('#playerbar.visible');
await page.waitForFunction(() => document.querySelector('#player').currentTime > 1, null, {timeout: 10000});
ok(true, 'audio plays and time advances');
ok((await page.locator('#pb-title').textContent()) === 'Everything That Glows', 'player shows chapter title');
ok(page.url().includes('#glows/ch-glows'), 'hash deep link updated');

// 4b. Now Playing drawer: opens from mini bar, tabs work, closes
await page.locator('#btn-np').click();
await page.waitForSelector('#np.open');
ok(await page.locator('#np-title').textContent() === 'Everything That Glows', 'drawer shows chapter title');
ok(await page.locator('.np-art .plate').count() === 1, 'drawer art plate rendered');
const tabNames = await page.locator('#np-tabs button').allTextContents();
ok(JSON.stringify(tabNames) === JSON.stringify(['Art','Up Next','Slides','Outline','Text']), `drawer tabs (${tabNames})`);
// Up Next: lists the book queue, marks now playing, and can switch tracks
await page.locator('#np-tabs [data-tab="chapters"]').click();
ok(await page.locator('.np-chapters .nrow').count() === 3, 'Up Next lists 3 playable items');
ok((await page.locator('.np-chapters .nrow.now .t2').textContent()) === 'Everything That Glows', 'Up Next marks now playing');
await page.locator('.np-chapters .nrow').nth(2).click();
await page.waitForFunction(() => document.querySelector('#np-title').textContent === 'Everything That Remembers', null, {timeout: 5000});
ok(true, 'Up Next switches track');
await page.locator('.np-chapters .nrow').nth(1).click();
await page.waitForFunction(() => document.querySelector('#np-title').textContent === 'Everything That Glows', null, {timeout: 5000});
// parity extras present
ok(await page.locator('#np-share').isVisible(), 'Share button present');
ok(await page.locator('#np-volrow').isVisible(), 'volume slider on desktop-class platform');
await page.locator('#np-vol').fill('40');
ok(Math.abs(await page.evaluate(() => document.querySelector('#player').volume) - 0.4) < 0.01, 'volume slider drives audio');
await page.locator('#np-vol').fill('100');
ok(await page.locator('#np-tabs a[target="_blank"]').count() === 1, 'drawer Read link present');
await page.locator('#np-tabs [data-tab="slides"]').click();
ok(await page.locator('#np-stage .sv-slide img').count() === 2, 'slides tab shows swipeable pages');
ok((await page.locator('#np-stage .sv-count').textContent()) === '1 of 2', 'slides pager counter');
ok(await page.locator('#np-stage .sv-prev').isDisabled(), 'prev arrow disabled on first slide');
await page.locator('#np-stage .sv-next').click();
await page.waitForFunction(() => {
  const c = document.querySelector('#np-stage .sv-count');
  return c && c.textContent === '2 of 2';
}, null, {timeout: 5000});
ok(true, 'next arrow advances the pager');
await page.locator('#np-tabs [data-tab="text"]').click();
await page.waitForFunction(() => document.querySelector('.np-doc') && document.querySelector('.np-doc').textContent.includes('remembers'), null, {timeout: 5000});
ok(await page.locator('.np-doc h2').textContent() === 'The Candle', 'text companion renders markdown heading');
ok(await page.locator('.np-doc strong').count() === 1, 'text companion renders bold');
// drawer transport mirrors state
ok(await page.evaluate(() => document.querySelector('#np-ic-pause').style.display !== 'none'), 'drawer shows pause while playing');
await page.locator('#np-play').click();
await page.waitForFunction(() => document.querySelector('#player').paused, null, {timeout: 5000});
ok(true, 'drawer play button toggles');
await page.locator('#np-play').click();
// Show in book: from the drawer straight to the chapter's row
await page.locator('#np-loc').click();
await page.waitForFunction(() => document.querySelector('#np').hidden, null, {timeout: 5000});
await page.waitForSelector('#view-book.active');
ok(await page.locator('.row.playing').count() === 1, 'show-in-book lands on highlighted playing row');
ok(await page.locator('.row.playing .eq').count() === 1, 'playing row shows equalizer');
ok(await page.evaluate(() => parseFloat(document.querySelector('#pb-hairline').style.width) > 0), 'mini-bar progress hairline advances');
// browser back returns home (real history)
await page.goBack();
await page.waitForSelector('#view-home.active', {timeout: 5000});
ok(true, 'browser back returns to the shelf');
ok(await page.evaluate(() => !document.querySelector('#player').paused), 'audio keeps playing across back-nav');
await page.locator('.cover').first().click();
await page.waitForSelector('#view-book.active');
await page.locator('#btn-np').click();
await page.waitForSelector('#np.open');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('#np').hidden, null, {timeout: 5000});
ok(true, 'Escape closes drawer');

// 4d. flags: mark a moment, see it in the Flags tab, timestamped deep link works
await page.locator('#btn-np').click();
await page.waitForSelector('#np.open');
await page.evaluate(() => { document.querySelector('#player').currentTime = 14; });
await page.waitForTimeout(300);
await page.locator('#np-flag').click();
await page.waitForSelector('#np-tabs [data-tab="flags"]', {timeout: 5000});
await page.locator('#np-tabs [data-tab="flags"]').click();
ok(await page.locator('.np-chapters .nrow').count() === 1, 'flag listed in Flags tab');
ok((await page.locator('.np-chapters .nrow .t2').textContent()).includes('0:14'), 'flag shows its timestamp');
ok(JSON.parse(await page.evaluate(() => localStorage.getItem('ab-flags')))[0].t === 14, 'flag persisted');
// jot a thought tied to the moment
await page.locator('.np-chapters [data-do="note"]').click();
await page.locator('.note-ed input').fill('the flame remembers');
await page.locator('.note-ed [data-do="save"]').click();
await page.waitForSelector('.nrow-note', {timeout: 5000});
ok((await page.locator('.nrow-note').textContent()) === 'the flame remembers', 'thought saved and shown on the timeline');
ok(JSON.parse(await page.evaluate(() => localStorage.getItem('ab-flags')))[0].n === 'the flame remembers', 'thought persisted with its timestamp');
ok(await page.locator('.np-art') === null || true, 'noop');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('#np').hidden, null, {timeout: 5000});
// timestamped deep link cues to the exact second
const ctx4 = await browser.newContext();
const page4 = await ctx4.newPage();
await page4.goto(`http://localhost:${PORT}/index.html?catalog=catalog.test.json#glows/ch-remembers@21`);
await page4.waitForSelector('#playerbar.visible');
ok((await page4.locator('#t-cur').textContent()) === '0:21', 'timestamped link cues to the exact second');
ok(await page4.evaluate(() => document.querySelector('#player').paused), 'timestamped link does not autoplay');
await ctx4.close();

// 4c. footer pages open in-app; audio never stops
await page.locator('footer a[data-page][href="privacy.html"]').click();
await page.waitForSelector('#page-overlay.open', {timeout: 5000});
ok((await page.locator('#page-title').textContent()).includes('Nothing about you'), 'privacy opens as in-app sheet');
ok(await page.evaluate(() => !document.querySelector('#player').paused), 'audio keeps playing while reading privacy');
ok(page.url().includes('index.html'), 'no navigation happened');
await page.locator('#page-close').click();

// 5. seek forward, then check saved position after reload
await page.locator('#btn-fwd30').click(); // clamps near end
await page.evaluate(() => { const a = document.querySelector('#player'); a.currentTime = 12; });
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('#player').pause()); // pause -> force save
await page.waitForTimeout(200);
const saved = await page.evaluate(() => localStorage.getItem('ab-pos:glows/ch-glows'));
ok(+saved >= 11 && +saved <= 13, `position saved on pause (${saved}s)`);

// 6. media session wired
const ms = await page.evaluate(() => navigator.mediaSession && navigator.mediaSession.metadata && {
  title: navigator.mediaSession.metadata.title, album: navigator.mediaSession.metadata.album,
  art0: navigator.mediaSession.metadata.artwork[0] && navigator.mediaSession.metadata.artwork[0].src});
ok(ms && ms.title === 'Everything That Glows' && ms.album === 'Everything That Glows', 'media session metadata set');
ok(ms.art0 && ms.art0.includes('cover-test.png'), 'car/lock-screen artwork is the real book cover');

// 7. speed persists
await page.locator('#btn-rate').click();
await page.locator('#menu-rate [data-rate="1.5"]').click();
ok(await page.evaluate(() => document.querySelector('#player').playbackRate) === 1.5, 'playback rate applied');

// 8. reload: continue card present, resume restores position
await page.goto(BASE);
await page.waitForSelector('.continue');
const contText = await page.locator('.continue').textContent();
ok(contText.includes('Everything That Glows') && contText.includes('0:12'), 'continue card with position');
await page.locator('.continue').click();
await page.waitForFunction(() => {
  const a = document.querySelector('#player');
  return a.currentTime >= 11.5 && !a.paused;
}, null, {timeout: 10000});
ok(true, 'resume restores saved position and plays');
ok(await page.evaluate(() => document.querySelector('#player').playbackRate) === 1.5, 'rate persisted across reload');

// 8b. multiple chapters keep independent positions (already in book view)
await page.locator('#bk-chapters .row [data-act="play"]').nth(1).click(); // ch-remembers
await page.waitForFunction(() => document.querySelector('#pb-title').textContent === 'Everything That Remembers', null, {timeout: 8000});
await page.evaluate(() => { document.querySelector('#player').currentTime = 7; });
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#player').pause());
await page.waitForTimeout(200);
const posA = await page.evaluate(() => localStorage.getItem('ab-pos:glows/ch-glows'));
const posB = await page.evaluate(() => localStorage.getItem('ab-pos:glows/ch-remembers'));
ok(+posA >= 11 && +posB === 7, `both chapters keep independent positions (${posA}s, ${posB}s)`);
// data status counts them
await page.locator('#btn-aa').click();
await page.waitForFunction(() => document.querySelector('#data-status').textContent.includes('2 chapters in progress'), null, {timeout: 5000});
ok(true, 'data panel reports chapters in progress');
// backup export → wipe → restore merges back
const backup = await page.evaluate(() => JSON.stringify({app: 'hear-my-book', schemaVersion: 1, data:
  Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('ab-')).map(k => [k, localStorage.getItem(k)]))}));
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('ab-pos:')) localStorage.removeItem(k); });
ok(await page.evaluate(() => localStorage.getItem('ab-pos:glows/ch-glows')) === null, 'positions wiped for the test');
await page.locator('#import-file').setInputFiles({name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup)});
await page.waitForFunction(() => localStorage.getItem('ab-pos:glows/ch-glows') !== null, null, {timeout: 5000});
ok(await page.evaluate(() => localStorage.getItem('ab-pos:glows/ch-remembers')) === '7', 'restore brings back every position');
await page.keyboard.press('Escape');
// resume the original chapter for the remaining tests
await page.locator('#bk-chapters .row [data-act="play"]').first().click();
await page.waitForFunction(() => document.querySelector('#pb-title').textContent === 'Everything That Glows', null, {timeout: 8000});
await page.waitForFunction(() => document.querySelector('#player').currentTime >= 11, null, {timeout: 8000});

// 9. ended -> marks done + auto-advance to next chapter
await page.evaluate(() => { const a = document.querySelector('#player'); a.currentTime = a.duration - 0.4; });
await page.waitForFunction(() => document.querySelector('#pb-title').textContent === 'Everything That Remembers', null, {timeout: 10000});
ok(true, 'auto-advances to next chapter on end');
ok(await page.evaluate(() => localStorage.getItem('ab-done:glows/ch-glows')) === '1', 'finished chapter marked done');

// 9b. journey card appears on the library page once progress exists
await page.goto(BASE);
await page.waitForSelector('#journey-slot .journey');
const jt = await page.locator('.journey .line').textContent();
ok(jt.includes('1 of 2 audio chapters finished'), `journey card counts progress (${jt.trim()})`);
ok(await page.locator('.journey .jb').count() === 3, 'journey shows a bar per book');

// 10. deep link cues without playing
const page2 = await ctx.newPage();
await page2.goto(`http://localhost:${PORT}/index.html?catalog=catalog.test.json#glows/ch-remembers`);
await page2.waitForSelector('#playerbar.visible');
ok((await page2.locator('#pb-title').textContent()) === 'Everything That Remembers', 'deep link cues chapter');
ok(await page2.evaluate(() => document.querySelector('#player').paused), 'deep link does not autoplay');

// 10b. unpublished book (no readUrl, no chapters): coming-soon states, extra still plays
const page3 = await ctx.newPage();
await page3.goto(`http://localhost:${PORT}/index.html?catalog=catalog.test.json#goes`);
await page3.waitForSelector('#view-book.active');
ok((await page3.locator('#bk-stat').textContent()) === 'in the works', 'unpublished book shows "in the works"');
ok(await page3.locator('#bk-read').isHidden(), 'read link hidden when no readUrl');
ok(await page3.locator('#bk-ch-label').isHidden(), 'chapters heading hidden when no chapters');
ok(await page3.locator('#bk-extras .row').count() === 1, 'preview extra listed for unpublished book');
ok(await page3.locator('.rowactions a').count() === 0, 'no Read action without readUrl');
await page3.locator('#bk-extras [data-act="play"]').click();
await page3.waitForFunction(() => document.querySelector('#player').currentTime > 0.5, null, {timeout: 10000});
ok(true, 'preview extra plays');
await page3.close();

// 11. keyboard: space toggles
await page2.keyboard.press(' ');
await page2.waitForFunction(() => !document.querySelector('#player').paused, null, {timeout: 8000});
ok(true, 'space starts playback');

ok(errors.length === 0, 'no page errors' + (errors.length ? ' — ' + errors.join(' | ') : ''));

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nall player tests passed');
process.exit(failures ? 1 : 0);
