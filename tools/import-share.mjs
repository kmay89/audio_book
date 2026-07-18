#!/usr/bin/env node
// Import a song/episode from a share page (e.g. an AI song generator's
// /song/<id> link): find the audio and artwork on the page, download them,
// and upload to the book's media release under the naming convention.
// Runs in GitHub Actions (open network); use dry-run first to see what the
// page actually serves (URL, content-type, size) before publishing.
//
// Usage:
//   node tools/import-share.mjs --url <share-url> --book <slug> --slug <slug> [--dry-run]
//   node tools/import-share.mjs --html <file> --book b --slug s --dry-run   (offline parser test)
//
// Env: GITHUB_TOKEN required unless --dry-run.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
};
const DRY = process.argv.includes('--dry-run');
const URL_IN = arg('url'), HTML_IN = arg('html'), BOOK = arg('book'), SLUG = arg('slug');
if ((!URL_IN && !HTML_IN) || !BOOK || !SLUG){
  console.error('usage: import-share.mjs --url <share-url> --book <book-slug> --slug <chapter-or-extra-slug> [--dry-run]');
  process.exit(1);
}
if (!/^[\w-]+$/.test(BOOK) || !/^[\w-]+$/.test(SLUG)){ console.error('book/slug must be simple slugs'); process.exit(1); }
if (URL_IN){
  try { const u = new URL(URL_IN); if (!/^https?:$/.test(u.protocol)) throw 0; }
  catch(e){ console.error('--url must be a valid http(s) URL'); process.exit(1); }
}

const UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 hear-my-book-import'};

// ---- 1. fetch & parse the share page ----
let html;
if (HTML_IN) html = fs.readFileSync(HTML_IN, 'utf8');
else {
  const res = await fetch(URL_IN, {headers: UA, redirect: 'follow'});
  if (!res.ok) throw new Error(`share page -> ${res.status}`);
  html = await res.text();
}

const meta = prop => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]+content\\s*=\\s*["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]+(?:property|name)\\s*=\\s*["']${prop}["']`, 'i'));
  return m ? m[1] : null;
};
const base = URL_IN || 'https://example.invalid/';
const unescapeUrl = u => {
  const clean = u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  try { return new URL(clean, base).href; } catch(e){ return clean; } // resolve relative against the page
};

const audioCandidates = new Set();
for (const p of ['og:audio:secure_url', 'og:audio', 'twitter:player:stream'])
  { const v = meta(p); if (v) audioCandidates.add(unescapeUrl(v)); }
for (const m of html.matchAll(/<(?:audio|source)[^>]+src\s*=\s*["']([^"']+)["']/gi)) audioCandidates.add(unescapeUrl(m[1]));
// generic sweep over an unescaped copy so JSON-embedded (\/-escaped) URLs match too
const flat = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
for (const m of flat.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:mp3|m4a|wav|ogg|opus)(?:\?[^\s"'<>\\]*)?/gi))
  audioCandidates.add(m[0]);

const artCandidates = new Set();
for (const p of ['og:image:secure_url', 'og:image', 'twitter:image'])
  { const v = meta(p); if (v) artCandidates.add(unescapeUrl(v)); }

const title = meta('og:title') || (html.match(/<title[^>]*>([^<]+)</i) || [])[1] || SLUG;

if (!audioCandidates.size){
  console.error('No audio URLs found on the page. The player may load audio via authenticated APIs;');
  console.error('in that case use the tool\'s own Download button and the normal release upload.');
  process.exit(2);
}

// ---- 2. probe candidates, pick the biggest real audio file ----
async function probe(u){
  try {
    const res = await fetch(u, {headers: {...UA, Range: 'bytes=0-1'}, redirect: 'follow'});
    const type = res.headers.get('content-type') || '';
    if (res.body) res.body.cancel().catch(() => {});
    if (!res.ok && res.status !== 206) return null;
    const range = res.headers.get('content-range');
    const size = range ? +range.split('/')[1] : +(res.headers.get('content-length') || 0);
    return {url: u, type, size};
  } catch(e){ return null; }
}
const probed = HTML_IN
  ? [...audioCandidates].map(u => ({url: u, type: '(not probed — offline)', size: 0}))
  : (await Promise.all([...audioCandidates].map(probe)))
      .filter(Boolean)
      .filter(p => /audio|octet-stream|mpeg|mp4/.test(p.type) || /\.(mp3|m4a|wav|ogg|opus)(\?|$)/.test(p.url))
      .sort((a, b) => b.size - a.size);

console.log(`page title: ${title}`);
console.log('audio candidates:');
for (const p of probed) console.log(`  ${(p.size / 1048576).toFixed(2).padStart(7)} MB  ${p.type.padEnd(24)} ${p.url}`);
for (const a of artCandidates) console.log(`artwork: ${a}`);
if (!probed.length){ console.error('No fetchable audio candidates.'); process.exit(2); }
const chosen = probed[0];
const art = [...artCandidates][0] || null;
console.log(`\nchosen audio: ${chosen.url}`);
if (chosen.size && chosen.size < 1_000_000) console.log('⚠ suspiciously small — may be a preview clip, check before publishing');

if (DRY){ console.log('\n[dry-run] nothing uploaded. Re-run without --dry-run to publish.'); process.exit(0); }

// ---- 3. download and upload to the media release ----
if (!process.env.GITHUB_TOKEN){ console.error('GITHUB_TOKEN required to upload'); process.exit(1); }
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const book = catalog.books.find(b => b.slug === BOOK);
if (!book) throw new Error(`no book '${BOOK}' in catalog.json`);

const gh = {'User-Agent': 'hear-my-book-import', Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`};
const rel = await (await fetch(`https://api.github.com/repos/${catalog.mediaRepo}/releases/tags/${book.releaseTag}`, {headers: gh})).json();
if (!rel.id) throw new Error(`release ${book.releaseTag} not found — create it first`);

async function put(name, buf, type){
  const dup = (rel.assets || []).find(a => a.name === name);
  if (dup){
    const del = await fetch(dup.url, {method: 'DELETE', headers: gh});
    if (!del.ok && del.status !== 204) throw new Error(`delete existing ${name} -> ${del.status}`);
    console.log(`replaced existing ${name}`);
  }
  const up = await fetch(rel.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(name)}`,
    {method: 'POST', headers: {...gh, 'Content-Type': type, 'Content-Length': String(buf.length)}, body: buf});
  if (!up.ok) throw new Error(`upload ${name} -> ${up.status} ${await up.text()}`);
  console.log(`uploaded ${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

const TYPE_EXT = [[/mpeg|mp3/, 'mp3'], [/mp4|m4a|aac/, 'm4a'], [/wav/, 'wav'], [/ogg|opus/, 'ogg']];
const extFromType = t => (TYPE_EXT.find(([re]) => re.test(t || '')) || [, null])[1];
const ext = (chosen.url.match(/\.(mp3|m4a|wav|ogg|opus)(\?|$)/) || [])[1] || extFromType(chosen.type) || 'mp3';
const audioBuf = Buffer.from(await (await fetch(chosen.url, {headers: UA, redirect: 'follow'})).arrayBuffer());
await put(`${BOOK}__${SLUG}.${ext}`, audioBuf, 'application/octet-stream');

if (art){
  try {
    const res = await fetch(art, {headers: UA, redirect: 'follow'});
    if (res.ok){
      const abuf = Buffer.from(await res.arrayBuffer());
      const aext = /png/.test(res.headers.get('content-type') || '') ? 'png' : 'jpg';
      await put(`${BOOK}__${SLUG}__slide-01.${aext}`, abuf, res.headers.get('content-type') || 'image/jpeg');
    }
  } catch(e){ console.log('artwork fetch failed (non-fatal):', e.message); }
}
console.log(`\ndone — "${title}" staged as ${BOOK}/${SLUG}. Now run the Sync workflow (or wait for the daily run).`);
