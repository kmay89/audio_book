#!/usr/bin/env node
// Sync catalog.json against the media releases on GitHub.
//
// The releases are the source of truth for media. For each book in catalog.json,
// this reads the release tagged `releaseTag` (e.g. media-glows) and wires its
// assets to chapters by filename convention:
//
//   <book>__<chapter-slug>.mp3            audio episode (.m4a/.wav also accepted)
//   <book>__<chapter-slug>__outline.txt   outline shown under the chapter (.md ok)
//   <book>__<chapter-slug>__slides.pdf    slide deck
//   <book>__<chapter-slug>__slide-01.png  slide images (numbered; .jpg/.webp ok)
//
// A slug that doesn't match a chapter becomes an "extra" (e.g. glows__overview.mp3
// — a whole-book NotebookLM overview). Durations are parsed from the file itself
// (download is skipped when the asset is unchanged). Assets removed from a release
// are unwired again. Manual catalog edits to outlines/titles are preserved unless
// a matching asset overrides them.
//
// Usage: node tools/sync.mjs [--dry-run]
// Env:   GITHUB_TOKEN (optional; raises API rate limits, required in CI)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {audioDuration} from './duration.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'catalog.json');
const DRY = process.argv.includes('--dry-run');

const AUDIO_EXT = ['.mp3', '.m4a', '.wav'];
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

const headers = {'User-Agent': 'audio-book-sync', Accept: 'application/vnd.github+json'};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function api(url){
  const res = await fetch(url, {headers});
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function download(asset){
  // the API asset URL + octet-stream works for public and private repos alike
  const url = asset.url || asset;
  const res = await fetch(url, {headers: {...headers, Accept: 'application/octet-stream'}, redirect: 'follow'});
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function parseName(name){
  // canonical: <book>__<slug>[__<extra>].<ext>
  const ext = path.extname(name).toLowerCase();
  const stem = name.slice(0, name.length - ext.length);
  const parts = stem.split('__');
  if (parts.length >= 2){
    const [book, slug, ...rest] = parts;
    return {book, slug, extra: rest.join('__') || null, ext, name};
  }
  // forgiving fallback: a single underscore after the book slug
  // (e.g. grows_ch-see.m4a) — book slugs never contain underscores
  const us = stem.indexOf('_');
  if (us > 0 && us < stem.length - 1)
    return {book: stem.slice(0, us), slug: stem.slice(us + 1), extra: null, ext, name};
  return null;
}

const titleFromSlug = slug =>
  slug.replace(/^ch-/, '').split('-').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');

async function main(){
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const before = JSON.stringify(catalog);
  const log = [];

  for (const book of catalog.books){
    const rel = await api(`https://api.github.com/repos/${catalog.mediaRepo}/releases/tags/${book.releaseTag}`);
    if (!rel){ log.push(`${book.slug}: no release '${book.releaseTag}' yet — skipped`); continue; }

    // group this release's assets by slug
    const bySlug = new Map();
    for (const asset of rel.assets){
      const p = parseName(asset.name);
      if (!p){ log.push(`${book.slug}: !! '${asset.name}' ignored (name must be <book>__<slug>[__extra].<ext>)`); continue; }
      if (p.book !== book.slug){ log.push(`${book.slug}: !! '${asset.name}' ignored (prefix '${p.book}' ≠ release book)`); continue; }
      if (!bySlug.has(p.slug)) bySlug.set(p.slug, []);
      bySlug.get(p.slug).push({...p, asset});
    }

    book.extras = book.extras || [];
    // drop extras whose media vanished from the release
    book.extras = book.extras.filter(x => bySlug.has(x.slug));

    const items = new Map(book.chapters.map(c => [c.slug, c]));
    for (const [slug, files] of bySlug){
      let item = items.get(slug) || book.extras.find(x => x.slug === slug);
      if (!item){
        item = {slug, title: titleFromSlug(slug), audio: null, outline: null, slides: []};
        book.extras.push(item);
        book.extras.sort((a, b) => a.slug.localeCompare(b.slug));
        log.push(`${book.slug}: + extra '${slug}'`);
      }

      // prefer .mp3 (the normalized form) when several encodings coexist
      const audioFile = AUDIO_EXT.map(ext => files.find(f => !f.extra && f.ext === ext)).find(Boolean);
      if (audioFile){
        const {asset} = audioFile;
        const prev = item.audio;
        if (prev && prev.assetId === asset.id && prev.bytes === asset.size){
          prev.url = 'media/' + asset.name;      // keep duration; refresh URLs in case of retag
          prev.sourceUrl = asset.browser_download_url;
        } else {
          process.stdout.write(`${book.slug}/${slug}: reading duration of ${asset.name} (${(asset.size/1048576).toFixed(1)} MB)…\n`);
          const buf = await download(asset);
          const duration = Math.round(audioDuration(buf, asset.name));
          item.audio = {
            file: asset.name,
            url: 'media/' + asset.name,          // served same-origin by Netlify (fetch-media.mjs)
            sourceUrl: asset.browser_download_url, // storage of record: the GitHub release
            bytes: asset.size,
            duration,
            assetId: asset.id,
            updated: asset.updated_at,
          };
          log.push(`${book.slug}: ✓ ${slug} audio ${asset.name} (${fmt(duration)})`);
        }
      } else if (item.audio){
        item.audio = null;
        log.push(`${book.slug}: − ${slug} audio removed (asset gone)`);
      }

      const textFile = files.find(f => f.extra === 'text' && ['.md', '.txt'].includes(f.ext));
      if (textFile){
        const t = {file: textFile.name, url: 'media/' + textFile.name, sourceUrl: textFile.asset.browser_download_url};
        if (JSON.stringify(item.text || null) !== JSON.stringify(t)){ item.text = t; log.push(`${book.slug}: ✓ ${slug} text companion`); }
      } else if (item.text){
        item.text = null;
        log.push(`${book.slug}: − ${slug} text companion removed (asset gone)`);
      }

      const outlineFile = files.find(f => f.extra === 'outline' && ['.txt', '.md'].includes(f.ext));
      if (outlineFile){
        const text = (await download(outlineFile.asset)).toString('utf8').trim();
        if (item.outline !== text){ item.outline = text; log.push(`${book.slug}: ✓ ${slug} outline`); }
        item.outlineFromAsset = true;
      } else if (item.outlineFromAsset){
        // only clear outlines this sync wrote — hand-edited catalog outlines stay
        item.outline = null;
        delete item.outlineFromAsset;
        log.push(`${book.slug}: − ${slug} outline removed (asset gone)`);
      }

      const slides = [];
      const pdf = files.find(f => f.extra === 'slides' && f.ext === '.pdf');
      if (pdf) slides.push({file: pdf.name, url: 'media/' + pdf.name, sourceUrl: pdf.asset.browser_download_url, type: 'pdf'});
      const imgs = files.filter(f => f.extra && f.extra.startsWith('slide-') && IMG_EXT.includes(f.ext))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
      for (const im of imgs) slides.push({file: im.name, url: 'media/' + im.name, sourceUrl: im.asset.browser_download_url, type: 'image'});
      if (JSON.stringify(slides) !== JSON.stringify(item.slides || [])){
        item.slides = slides;
        log.push(`${book.slug}: ✓ ${slug} slides (${slides.length})`);
      }
    }

    // unwire chapter audio whose assets vanished
    for (const c of book.chapters){
      if (c.audio && !bySlug.has(c.slug)){
        c.audio = null; c.slides = []; c.text = null;
        if (c.outlineFromAsset){ c.outline = null; delete c.outlineFromAsset; }
        log.push(`${book.slug}: − ${c.slug} unwired (no assets in release)`);
      }
    }
  }

  const after = JSON.stringify(catalog);
  for (const line of log) console.log(line);
  if (after === before){ console.log('catalog.json unchanged.'); return; }
  catalog.updated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (DRY){ console.log('[dry-run] catalog.json would change.'); return; }
  fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
  console.log('catalog.json updated.');
}

const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2, '0')}`;

main().catch(err => { console.error(err.message || err); process.exit(1); });
