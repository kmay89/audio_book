#!/usr/bin/env node
// Production health check: fetch the LIVE site and assert it's actually
// correct — every audio/slide URL really serves media (not a 404 SPA
// fallback), ranges work, and each book's feed is valid with reachable
// episodes. Run on a schedule + after deploys; it fails loudly (job failure →
// notification) so a broken asset is caught before a listener hits it.
//
//   node tools/healthcheck.mjs [base-url]     # default: catalog.json siteUrl
//
// Split into a pure runChecks() (fetch injected) so the logic is unit-tested
// without the network; the CLI wires real fetch.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {referencedAssets} from './lib-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MEDIA_OK = ['audio/', 'video/', 'application/pdf', 'image/', 'application/octet-stream'];

async function checkAsset(base, asset, fetchImpl){
  const url = base.replace(/\/$/, '') + '/' + asset.url.replace(/^\//, '');
  try {
    const res = await fetchImpl(url, {headers: {Range: 'bytes=0-1'}, redirect: 'follow'});
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (res.status !== 200 && res.status !== 206)
      return {name: asset.url, ok: false, detail: `HTTP ${res.status}`};
    if (ct.includes('text/html'))
      return {name: asset.url, ok: false, detail: `served text/html — the file is missing (SPA fallback)`};
    if (!MEDIA_OK.some(p => ct.startsWith(p)))
      return {name: asset.url, ok: false, detail: `unexpected content-type ${ct || '(none)'}`};
    if (asset.kind === 'audio' && res.status !== 206)
      return {name: asset.url, ok: false, detail: 'no range support (206) — seeking would break'};
    return {name: asset.url, ok: true, detail: ct};
  } catch (e){
    return {name: asset.url, ok: false, detail: e.message};
  }
}

async function checkFeed(base, slug, fetchImpl){
  const url = base.replace(/\/$/, '') + `/feed-${slug}.xml`;
  try {
    const res = await fetchImpl(url, {redirect: 'follow'});
    if (res.status !== 200) return {name: `feed-${slug}.xml`, ok: false, detail: `HTTP ${res.status}`};
    const body = await res.text();
    if (!body.includes('<rss') || !body.includes('<enclosure'))
      return {name: `feed-${slug}.xml`, ok: false, detail: 'not a valid feed with episodes'};
    return {name: `feed-${slug}.xml`, ok: true, detail: 'ok'};
  } catch (e){
    return {name: `feed-${slug}.xml`, ok: false, detail: e.message};
  }
}

async function pool(items, n, worker){
  const out = [];
  let i = 0;
  await Promise.all(Array.from({length: Math.min(n, items.length)}, async () => {
    while (i < items.length){
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }));
  return out;
}

export async function runChecks(catalog, {base, fetchImpl = fetch, concurrency = 8} = {}){
  const assets = referencedAssets(catalog);
  const assetChecks = await pool(assets, concurrency, a => checkAsset(base, a, fetchImpl));
  const feedBooks = catalog.books.filter(b => (b.chapters || []).some(c => c.audio));
  const feedChecks = await pool(feedBooks, concurrency, b => checkFeed(base, b.slug, fetchImpl));
  const checks = [...assetChecks, ...feedChecks];
  return {checks, ok: checks.every(c => c.ok), assets: assets.length, feeds: feedChecks.length};
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const base = process.argv[2] || local.siteUrl;
  if (!base){ console.error('no base URL (set siteUrl in catalog.json or pass one)'); process.exit(2); }
  console.log(`\n  Health check against ${base}\n`);
  let catalog = local;
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/catalog.json', {cache: 'no-cache'});
    if (res.ok) catalog = await res.json();
    else console.log(`  (using local catalog; live catalog.json returned ${res.status})`);
  } catch (e){
    console.log(`  (using local catalog; couldn't fetch live: ${e.message})`);
  }
  const {checks, ok, assets, feeds} = await runChecks(catalog, {base});
  for (const c of checks.filter(c => !c.ok)) console.log(`  ✗ ${c.name} — ${c.detail}`);
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n  ${assets} assets + ${feeds} feeds checked · ${failed} problem(s)`);
  if (!ok){ console.error('\n  Site health check FAILED — see above.'); process.exit(1); }
  console.log('  Everything the catalog promises is live and playable. ✓');
}
