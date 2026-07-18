#!/usr/bin/env node
// Rasterize slide decks: convert each <book>__<slug>__slides.pdf release
// asset into per-page <book>__<slug>__slide-NN.jpg images and upload them
// back to the same release. The PDF stays in place as the downloadable deck;
// the player shows the page images as a swipeable viewer. Runs in CI
// (needs poppler-utils' pdftoppm) before the sync.
//
// Chapters that already have any __slide-NN images are skipped, so
// hand-uploaded slide images always win over the generated ones.
//
// Usage: node tools/slides.mjs [--dry-run]
// Env:   GITHUB_TOKEN (required — uploads need auth)
//        PDFTOPPM (optional path override, default "pdftoppm")

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// shared with sync.mjs: canonical double underscore, single tolerated
import {parseName} from './sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const PDFTOPPM = process.env.PDFTOPPM || 'pdftoppm';
const MAX_PAGES = 60; // sanity cap; a longer "deck" is probably a document

if (!process.env.GITHUB_TOKEN){ console.error('GITHUB_TOKEN is required'); process.exit(1); }
const headers = {
  'User-Agent': 'audio-book-slides',
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
};

async function api(url, init = {}){
  const res = await fetch(url, {headers: {...headers, ...(init.headers || {})}, ...init});
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slides-'));
let work = 0;

for (const book of catalog.books){
  const rel = await api(`https://api.github.com/repos/${catalog.mediaRepo}/releases/tags/${book.releaseTag}`);
  if (!rel) continue;

  // slugs that already have page images (hand-uploaded or from a prior run)
  const haveImages = new Set();
  for (const a of rel.assets){
    const p = parseName(a.name);
    if (p && p.book === book.slug && /^slide-\d+$/.test(p.extra || '')) haveImages.add(p.slug);
  }

  for (const asset of rel.assets){
    const p = parseName(asset.name);
    if (!p || p.book !== book.slug || p.extra !== 'slides' || p.ext !== '.pdf') continue;
    if (haveImages.has(p.slug)){ console.log(`${asset.name}: slide images already exist — skip`); continue; }
    work++;
    console.log(`${asset.name} (${(asset.size/1048576).toFixed(1)} MB) -> ${book.slug}__${p.slug}__slide-NN.jpg${DRY ? ' [dry-run]' : ''}`);
    if (DRY) continue;

    const inFile = path.join(tmp, asset.name);
    const res = await fetch(asset.url, {headers: {...headers, Accept: 'application/octet-stream'}, redirect: 'follow'});
    if (!res.ok) throw new Error(`download ${asset.name} -> ${res.status}`);
    fs.writeFileSync(inFile, Buffer.from(await res.arrayBuffer()));

    // ~1200px wide pages: crisp on phones/drawer, small enough to swipe through
    const stem = path.join(tmp, `${book.slug}__${p.slug}__page`);
    execFileSync(PDFTOPPM, ['-jpeg', '-jpegopt', 'quality=87', '-r', '110',
      '-l', String(MAX_PAGES), inFile, stem], {stdio: 'inherit'});

    const pages = fs.readdirSync(tmp)
      .filter(f => f.startsWith(path.basename(stem)) && f.endsWith('.jpg'))
      .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    if (!pages.length) throw new Error(`${asset.name}: pdftoppm produced no pages`);
    if (pages.length === MAX_PAGES)
      console.log(`  !! capped at ${MAX_PAGES} pages — later pages were not converted`);

    for (let i = 0; i < pages.length; i++){
      const target = `${book.slug}__${p.slug}__slide-${String(i + 1).padStart(2, '0')}.jpg`;
      const jpg = fs.readFileSync(path.join(tmp, pages[i]));
      const uploadUrl = rel.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(target)}`;
      const up = await fetch(uploadUrl, {
        method: 'POST',
        headers: {...headers, 'Content-Type': 'image/jpeg', 'Content-Length': String(jpg.length)},
        body: jpg,
      });
      if (!up.ok) throw new Error(`upload ${target} -> ${up.status} ${await up.text()}`);
      fs.rmSync(path.join(tmp, pages[i]));
    }
    console.log(`  uploaded ${pages.length} page image(s)`);
    fs.rmSync(inFile);
  }
}
console.log(work ? `rasterized ${work} deck(s).` : 'no decks to rasterize.');
