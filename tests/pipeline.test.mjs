// Unit tests for the health check (tools/healthcheck.mjs) and the release
// manifest (tools/manifest.mjs). Pure — fetch is injected, no network.
import {runChecks} from '../tools/healthcheck.mjs';
import {manifestObject} from '../tools/manifest.mjs';

let fail = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fail++; };

function fakeFetch(map){
  return async (url) => {
    const r = map[url] || {status: 404, ct: 'text/html', body: ''};
    return {
      status: r.status,
      headers: {get: k => (k.toLowerCase() === 'content-type' ? r.ct : null)},
      text: async () => r.body || '',
    };
  };
}

const catalog = {
  siteUrl: 'https://x', mediaRepo: 'kmay89/audio_book',
  books: [{
    slug: 'grows', releaseTag: 'media-grows',
    chapters: [{n: 1, slug: 'ch-a', title: 'A',
      audio: {file: 'grows__ch-a.mp3', url: 'media/grows__ch-a.mp3', duration: 100},
      slides: [{file: 'grows__ch-a__slide-01.jpg', url: 'media/grows__ch-a__slide-01.jpg', type: 'image'}]}],
  }],
};
const A = 'https://x/media/grows__ch-a.mp3';
const S = 'https://x/media/grows__ch-a__slide-01.jpg';
const F = 'https://x/feed-grows.xml';
const feedBody = '<rss><item><enclosure url="https://x/media/grows__ch-a.mp3"/></item></rss>';

async function main(){
  // all healthy
  let r = await runChecks(catalog, {base: 'https://x', concurrency: 4, fetchImpl: fakeFetch({
    [A]: {status: 206, ct: 'audio/mpeg'},
    [S]: {status: 200, ct: 'image/jpeg'},
    [F]: {status: 200, ct: 'application/xml', body: feedBody},
  })});
  ok(r.ok, 'all-healthy site passes');

  // missing audio → served as the HTML SPA fallback
  r = await runChecks(catalog, {base: 'https://x', concurrency: 4, fetchImpl: fakeFetch({
    [A]: {status: 200, ct: 'text/html', body: '<!doctype html>'},
    [S]: {status: 200, ct: 'image/jpeg'},
    [F]: {status: 200, ct: 'application/xml', body: feedBody},
  })});
  ok(!r.ok && r.checks.some(c => c.name === 'media/grows__ch-a.mp3' && /missing/.test(c.detail)),
    'a missing asset (html fallback) fails the check');

  // audio without range support
  r = await runChecks(catalog, {base: 'https://x', concurrency: 4, fetchImpl: fakeFetch({
    [A]: {status: 200, ct: 'audio/mpeg'},
    [S]: {status: 200, ct: 'image/jpeg'},
    [F]: {status: 200, ct: 'application/xml', body: feedBody},
  })});
  ok(!r.ok && r.checks.some(c => /range support/.test(c.detail)), 'audio without 206 range fails');

  // broken feed
  r = await runChecks(catalog, {base: 'https://x', concurrency: 4, fetchImpl: fakeFetch({
    [A]: {status: 206, ct: 'audio/mpeg'},
    [S]: {status: 200, ct: 'image/jpeg'},
    [F]: {status: 404, ct: 'text/html'},
  })});
  ok(!r.ok && r.checks.some(c => c.name === 'feed-grows.xml' && !c.ok), 'a missing feed fails');

  // manifest normalization
  const m = manifestObject('media-grows', [
    {name: 'b.mp3', size: 2, digest: 'sha256:beef'},
    {name: 'a.mp3', size: 1, digest: 'sha256:dead'},
    {name: 'c.txt', size: 3, digest: ''},
  ]);
  ok(m.count === 3 && m.assets[0].name === 'a.mp3', 'manifest sorts assets by name');
  ok(m.assets[0].sha256 === 'dead' && m.assets[2].sha256 === null, 'manifest strips the sha256: prefix, null when absent');

  console.log(fail ? `\n${fail} FAILURES` : '\nall pipeline tests passed');
  process.exit(fail ? 1 : 0);
}
main();
