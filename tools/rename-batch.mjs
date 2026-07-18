#!/usr/bin/env node
// Rename a folder of numbered chapter files into the release naming
// convention, using the chapter order from catalog.json.
//
//   node tools/rename-batch.mjs <book-slug> <folder> [--dry-run]
//
// Expects files whose names START with the chapter number: 1.m4a, 01.mp3,
// "03 anything.wav", "7.pdf", "12 deck.pdf" … Audio keeps its extension;
// .pdf becomes the chapter's __slides.pdf; images (.png/.jpg/.jpeg/.webp)
// with the same leading number become __slide-01, __slide-02 … in name order.
// Files that don't start with a number (or exceed the chapter count) are
// left alone and listed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [BOOK, FOLDER] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const DRY = process.argv.includes('--dry-run');
if (!BOOK || !FOLDER){
  console.error('usage: node tools/rename-batch.mjs <book-slug> <folder> [--dry-run]');
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const book = catalog.books.find(b => b.slug === BOOK);
if (!book) { console.error(`no book '${BOOK}' in catalog.json`); process.exit(1); }
const bySlugN = new Map(book.chapters.map(c => [c.n, c.slug]));

const AUDIO = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.opus'];
const IMG = ['.png', '.jpg', '.jpeg', '.webp'];
const files = fs.readdirSync(FOLDER).filter(f => !f.startsWith('.')).sort(
  (a, b) => a.localeCompare(b, undefined, {numeric: true}));

const imgCount = new Map();
let renamed = 0;
const untouched = [];
for (const f of files){
  const m = f.match(/^(\d{1,2})\b/);
  const ext = path.extname(f).toLowerCase();
  const n = m ? +m[1] : null;
  const slug = n != null ? bySlugN.get(n) : null;
  let target = null;
  if (slug && AUDIO.includes(ext)) target = `${BOOK}__${slug}${ext}`;
  else if (slug && ext === '.pdf') target = `${BOOK}__${slug}__slides.pdf`;
  else if (slug && IMG.includes(ext)){
    const k = (imgCount.get(slug) || 0) + 1;
    imgCount.set(slug, k);
    target = `${BOOK}__${slug}__slide-${String(k).padStart(2, '0')}${ext}`;
  }
  if (!target){ untouched.push(f); continue; }
  if (f === target) continue;
  if (fs.existsSync(path.join(FOLDER, target))){ console.log(`skip ${f} — ${target} already exists`); continue; }
  console.log(`${f}  →  ${target}`);
  if (!DRY) fs.renameSync(path.join(FOLDER, f), path.join(FOLDER, target));
  renamed++;
}
if (untouched.length) console.log(`\nleft alone (no leading chapter number or unknown type): ${untouched.join(', ')}`);
console.log(`\n${DRY ? '[dry-run] would rename' : 'renamed'} ${renamed} file(s).`);
console.log(`next: gh release upload ${book.releaseTag} * --repo ${catalog.mediaRepo} --clobber`);
