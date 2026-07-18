#!/usr/bin/env node
// Import songs/episodes from share pages (e.g. an AI song generator's
// /song/<id> links): find the audio and artwork on each page, download them,
// and upload to the book's media release under the naming convention.
//
// Accepts one or many URLs (space/comma/newline separated). A URL whose page
// contains no audio but links to /song/ pages on the same site is treated as
// a listing/profile page and expanded — so a whole profile can import in one
// run. Slugs are derived from each song's title unless --slug is given
// (single-URL only). Already-imported names are skipped, so reruns are safe.
//
// Runs in GitHub Actions (open network); dry-run first to see what each page
// serves (URL, content-type, size) before publishing.
//
// Usage:
//   node tools/import-share.mjs --url "<url> [<url>…]" --book <slug> [--slug <slug>] [--dry-run]
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
const HTML_IN = arg('html'), BOOK = arg('book'), SLUG_IN = arg('slug');
const URLS = (arg('url') || '').split(/[\s,]+/).filter(Boolean);
if ((!URLS.length && !HTML_IN) || !BOOK){
  console.error('usage: import-share.mjs --url "<share-url> …" --book <book-slug> [--slug <slug>] [--dry-run]');
  process.exit(1);
}
if (!/^[\w-]+$/.test(BOOK) || (SLUG_IN && !/^[\w-]+$/.test(SLUG_IN))){ console.error('book/slug must be simple slugs'); process.exit(1); }
if (SLUG_IN && URLS.length > 1){ console.error('--slug only makes sense with a single URL'); process.exit(1); }
for (const u of URLS){
  try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) throw 0; }
  catch(e){ console.error(`not a valid http(s) URL: ${u}`); process.exit(1); }
}

const UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 hear-my-book-import'};
const slugify = s => ('song-' + String(s).toLowerCase().normalize('NFKD')
  .replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
  .slice(0, 60).replace(/-+$/, '') || 'song-untitled';

// ---------- page parsing ----------
function parsePage(html, baseUrl){
  const meta = prop => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]+content\\s*=\\s*["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]+(?:property|name)\\s*=\\s*["']${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  const resolveUrl = u => {
    const clean = u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    try { return new URL(clean, baseUrl).href; } catch(e){ return clean; }
  };

  const audio = new Set();
  for (const p of ['og:audio:secure_url', 'og:audio', 'twitter:player:stream'])
    { const v = meta(p); if (v) audio.add(resolveUrl(v)); }
  for (const m of html.matchAll(/<(?:audio|source)[^>]+src\s*=\s*["']([^"']+)["']/gi)) audio.add(resolveUrl(m[1]));
  const flat = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  for (const m of flat.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:mp3|m4a|wav|ogg|opus)(?:\?[^\s"'<>\\]*)?/gi))
    audio.add(m[0]);

  const art = new Set();
  for (const p of ['og:image:secure_url', 'og:image', 'twitter:image'])
    { const v = meta(p); if (v) art.add(resolveUrl(v)); }

  // links to song pages on the same site (for listing/profile expansion)
  const songLinks = new Set();
  let host = null; try { host = new URL(baseUrl).host; } catch(e){}
  for (const m of flat.matchAll(/(?:href\s*=\s*["']|")((?:https?:\/\/[^\s"'<>]+)?\/song\/[\w-]+[^\s"'<>]*)["']/gi)){
    const u = resolveUrl(m[1]);
    try { if (!host || new URL(u).host === host) songLinks.add(u.split('#')[0]); } catch(e){}
  }

  const title = meta('og:title') || (html.match(/<title[^>]*>([^<]+)</i) || [])[1] || null;
  return {audio: [...audio], art: [...art], songLinks: [...songLinks], title: title && title.trim()};
}

async function fetchPage(url){
  const res = await fetch(url, {headers: UA, redirect: 'follow'});
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

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

// ---------- github release plumbing ----------
let rel = null, gh = null, catalog = null;
async function ensureRelease(){
  if (rel) return rel;
  catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const book = catalog.books.find(b => b.slug === BOOK);
  if (!book) throw new Error(`no book '${BOOK}' in catalog.json`);
  gh = {'User-Agent': 'hear-my-book-import', Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`};
  let r = await fetch(`https://api.github.com/repos/${catalog.mediaRepo}/releases/tags/${book.releaseTag}`, {headers: gh});
  if (r.status === 404){
    console.log(`release ${book.releaseTag} missing — creating it`);
    r = await fetch(`https://api.github.com/repos/${catalog.mediaRepo}/releases`, {
      method: 'POST', headers: gh,
      body: JSON.stringify({tag_name: book.releaseTag, name: `${book.title} — media`, body: `Media for ${book.title}. Managed by the publishing pipeline.`}),
    });
  }
  if (!r.ok) throw new Error(`release ${book.releaseTag} -> ${r.status} ${await r.text()}`);
  rel = await r.json();
  return rel;
}
async function put(name, buf, type){
  const dup = (rel.assets || []).find(a => a.name === name);
  if (dup){
    const del = await fetch(dup.url, {method: 'DELETE', headers: gh});
    if (!del.ok && del.status !== 204) throw new Error(`delete existing ${name} -> ${del.status}`);
    console.log(`  replaced existing ${name}`);
  }
  const up = await fetch(rel.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(name)}`,
    {method: 'POST', headers: {...gh, 'Content-Type': type, 'Content-Length': String(buf.length)}, body: buf});
  if (!up.ok) throw new Error(`upload ${name} -> ${up.status} ${await up.text()}`);
  console.log(`  uploaded ${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
  rel.assets = [...(rel.assets || []).filter(a => a.name !== name), {name, url: null}];
}

// ---------- import one song page ----------
const usedSlugs = new Set();
let imported = 0, skipped = 0, failed = 0;

async function importSong(url, page){
  const probed = HTML_IN
    ? page.audio.map(u => ({url: u, type: '(not probed — offline)', size: 0}))
    : (await Promise.all(page.audio.map(probe)))
        .filter(Boolean)
        .filter(p => /audio|octet-stream|mpeg|mp4/.test(p.type) || /\.(mp3|m4a|wav|ogg|opus)(\?|$)/.test(p.url))
        .sort((a, b) => b.size - a.size);
  if (!probed.length){ console.log('  no fetchable audio — skipped'); failed++; return; }
  const chosen = probed[0];
  let slug = SLUG_IN || slugify(page.title || url.split('/').pop());
  while (usedSlugs.has(slug)) slug += '-2';
  usedSlugs.add(slug);

  console.log(`  title:  ${page.title || '(untitled)'}`);
  for (const p of probed) console.log(`  audio:  ${(p.size / 1048576).toFixed(2)} MB  ${p.type}  ${p.url}`);
  if (page.art[0]) console.log(`  art:    ${page.art[0]}`);
  console.log(`  → ${BOOK}__${slug}`);
  if (chosen.size && chosen.size < 1_000_000) console.log('  ⚠ suspiciously small — may be a preview clip');

  if (DRY){ imported++; return; }

  await ensureRelease();
  const existing = (rel.assets || []).some(a => a.name.startsWith(`${BOOK}__${slug}.`));
  if (existing && !SLUG_IN){ console.log('  already in the release — skipped (delete the asset to re-import)'); skipped++; return; }

  const ext = (chosen.url.match(/\.(mp3|m4a|wav|ogg|opus)(\?|$)/) || [])[1]
    || ([[/mpeg|mp3/, 'mp3'], [/mp4|m4a|aac/, 'm4a'], [/wav/, 'wav'], [/ogg|opus/, 'ogg']]
        .find(([re]) => re.test(chosen.type)) || [, 'mp3'])[1];
  const audioBuf = Buffer.from(await (await fetch(chosen.url, {headers: UA, redirect: 'follow'})).arrayBuffer());
  await put(`${BOOK}__${slug}.${ext}`, audioBuf, 'application/octet-stream');
  if (page.art[0]){
    try {
      const res = await fetch(page.art[0], {headers: UA, redirect: 'follow'});
      if (res.ok){
        const abuf = Buffer.from(await res.arrayBuffer());
        const aext = /png/.test(res.headers.get('content-type') || '') ? 'png' : 'jpg';
        await put(`${BOOK}__${slug}__slide-01.${aext}`, abuf, res.headers.get('content-type') || 'image/jpeg');
      }
    } catch(e){ console.log('  artwork fetch failed (non-fatal):', e.message); }
  }
  imported++;
}

// ---------- main ----------
if (HTML_IN){
  const page = parsePage(fs.readFileSync(HTML_IN, 'utf8'), 'https://example.invalid/');
  console.log(`page: (local file)`);
  if (page.songLinks.length) console.log(`song links found: ${page.songLinks.join(', ')}`);
  await importSong('file://' + HTML_IN, page);
} else {
  // expand listing/profile pages into their song links
  const songUrls = [];
  for (const u of URLS){
    console.log(`\nfetching ${u}`);
    let page;
    try { page = parsePage(await fetchPage(u), u); }
    catch(e){ console.log(`  failed: ${e.message}`); failed++; continue; }
    const others = page.songLinks.filter(s => s !== u.split('#')[0]);
    if (!page.audio.length && others.length){
      console.log(`  looks like a listing — ${others.length} song link(s) found, expanding`);
      songUrls.push(...others);
    } else {
      songUrls.push({url: u, page});
      if (others.length) console.log(`  note: page also links to ${others.length} other song page(s) — pass a profile/listing URL to batch them`);
    }
  }
  const seen = new Set();
  for (const item of songUrls){
    const url = typeof item === 'string' ? item : item.url;
    if (seen.has(url)) continue;
    seen.add(url);
    console.log(`\nimporting ${url}`);
    try {
      const page = typeof item === 'string' ? parsePage(await fetchPage(url), url) : item.page;
      await importSong(url, page);
    } catch(e){ console.log(`  failed: ${e.message}`); failed++; }
  }
}

console.log(`\n${DRY ? '[dry-run] ' : ''}summary: ${imported} ${DRY ? 'ready to import' : 'imported'}, ${skipped} skipped, ${failed} failed.`);
if (DRY) console.log('Re-run with publish enabled to upload.');
process.exit(failed && !imported ? 2 : 0);
