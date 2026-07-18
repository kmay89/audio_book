#!/usr/bin/env node
// Normalize media releases: transcode any non-MP3 audio asset to a web-safe
// MP3 (128 kbps, 44.1 kHz) and upload it back to the same release under the
// canonical <book>__<slug>.mp3 name. Originals are left in place; sync.mjs
// prefers the .mp3. Runs in CI (ubuntu runners ship ffmpeg) before the sync.
//
// Why: NotebookLM and friends emit whatever they like — high-bitrate AAC in
// fragmented/DASH MP4 containers, or WAV — which is oversized and, for
// fragmented MP4, unreliable in a plain <audio> element on some browsers.
// A boring CBR MP3 plays and seeks everywhere.
//
// Usage: node tools/normalize.mjs [--dry-run]
// Env:   GITHUB_TOKEN (required — uploads need auth)
//        FFMPEG (optional path override, default "ffmpeg")

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// shared with sync.mjs: canonical double underscore, single tolerated
import {parseName} from './sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const AUDIO_EXT = ['.m4a', '.wav', '.aac', '.ogg', '.opus', '.webm', '.mp4'];

if (!process.env.GITHUB_TOKEN){ console.error('GITHUB_TOKEN is required'); process.exit(1); }
const headers = {
  'User-Agent': 'audio-book-normalize',
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'normalize-'));
let work = 0;

for (const book of catalog.books){
  const rel = await api(`https://api.github.com/repos/${catalog.mediaRepo}/releases/tags/${book.releaseTag}`);
  if (!rel) continue;
  const names = new Set(rel.assets.map(a => a.name));
  for (const asset of rel.assets){
    const p = parseName(asset.name);
    if (!p || p.extra || !AUDIO_EXT.includes(p.ext)) continue;
    if (p.book !== book.slug) continue;
    const target = `${p.book}__${p.slug}.mp3`;
    if (names.has(target)){ console.log(`${asset.name}: ${target} already exists — skip`); continue; }
    work++;
    console.log(`${asset.name} (${(asset.size/1048576).toFixed(1)} MB) -> ${target}${DRY ? ' [dry-run]' : ''}`);
    if (DRY) continue;

    const inFile = path.join(tmp, asset.name);
    const outFile = path.join(tmp, target);
    const res = await fetch(asset.url, {headers: {...headers, Accept: 'application/octet-stream'}, redirect: 'follow'});
    if (!res.ok) throw new Error(`download ${asset.name} -> ${res.status}`);
    fs.writeFileSync(inFile, Buffer.from(await res.arrayBuffer()));

    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', inFile, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', outFile],
      {stdio: 'inherit'});
    const mp3 = fs.readFileSync(outFile);
    console.log(`  transcoded: ${(mp3.length/1048576).toFixed(1)} MB`);

    const uploadUrl = rel.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(target)}`;
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: {...headers, 'Content-Type': 'audio/mpeg', 'Content-Length': String(mp3.length)},
      body: mp3,
    });
    if (!up.ok) throw new Error(`upload ${target} -> ${up.status} ${await up.text()}`);
    console.log(`  uploaded ${target}`);
    fs.rmSync(inFile); fs.rmSync(outFile);
  }
}
console.log(work ? `normalized ${work} asset(s).` : 'nothing to normalize.');
