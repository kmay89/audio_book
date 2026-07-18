#!/usr/bin/env node
// Netlify build step: download every media file referenced by catalog.json
// into media/, so Netlify serves the audio itself — same-origin, with a real
// audio MIME type and byte-range support.
//
// Why: GitHub release downloads are forced to
// Content-Type: application/octet-stream + Content-Disposition: attachment,
// which iOS Safari refuses to play in an <audio> element. GitHub Releases
// stay the upload box and source of truth (sourceUrl); Netlify is the wire.
//
// Usage: node tools/fetch-media.mjs   (no auth needed — public release URLs)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = path.join(ROOT, 'media');
fs.mkdirSync(MEDIA, {recursive: true});

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));

const jobs = [];
for (const book of catalog.books){
  for (const item of [...book.chapters, ...(book.extras || [])]){
    if (item.audio && item.audio.sourceUrl)
      jobs.push({name: item.audio.file, url: item.audio.sourceUrl, bytes: item.audio.bytes});
    for (const s of item.slides || [])
      if (s.sourceUrl) jobs.push({name: s.file, url: s.sourceUrl, bytes: null});
  }
}

let fetched = 0, kept = 0;
for (const job of jobs){
  if (!/^[\w.-]+$/.test(job.name)) throw new Error(`unsafe media name: ${job.name}`);
  const dest = path.join(MEDIA, job.name);
  if (fs.existsSync(dest) && (!job.bytes || fs.statSync(dest).size === job.bytes)){ kept++; continue; }
  process.stdout.write(`fetching ${job.name}…\n`);
  const res = await fetch(job.url, {redirect: 'follow', headers: {'User-Agent': 'hear-my-book-build'}});
  if (!res.ok) throw new Error(`${job.url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (job.bytes && buf.length !== job.bytes)
    throw new Error(`${job.name}: got ${buf.length} bytes, catalog says ${job.bytes}`);
  fs.writeFileSync(dest, buf);
  fetched++;
}
console.log(`media ready: ${fetched} fetched, ${kept} already present, ${jobs.length} total.`);
