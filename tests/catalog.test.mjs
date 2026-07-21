// Unit tests for the catalog guard rails (tools/lib-catalog.mjs) and the
// status dashboard (tools/status.mjs). Pure, no network.
import {referencedAssets, validateCatalog, hasErrors} from '../tools/lib-catalog.mjs';
import {statusMarkdown} from '../tools/status.mjs';

let fail = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fail++; };
const msgs = ps => ps.map(p => p.msg).join(' | ');
const errs = ps => ps.filter(p => p.level === 'error');

const good = {
  siteUrl: 'https://hear-my-book.com', mediaRepo: 'kmay89/audio_book',
  books: [{
    slug: 'grows', title: 'Everything That Grows', releaseTag: 'media-grows', order: 2, readUrl: 'x',
    chapters: [
      {n: 1, slug: 'ch-a', title: 'A', audio: {file: 'grows__ch-a.mp3', url: 'media/grows__ch-a.mp3', duration: 100},
       slides: [{file: 'grows__ch-a__slide-01.jpg', url: 'media/x', type: 'image'}]},
      {n: 2, slug: 'ch-b', title: 'B', audio: null, slides: []},
    ],
  }],
};

// --- referencedAssets
ok(referencedAssets(good).length === 2, 'referencedAssets flattens audio + slides');

// --- clean catalog passes
ok(!hasErrors(validateCatalog(good)), 'a well-formed catalog has no errors');

// --- duplicate book slug
{
  const c = structuredClone(good); c.books.push(structuredClone(good.books[0]));
  ok(errs(validateCatalog(c)).some(p => /duplicate book slug/.test(p.msg)), 'duplicate book slug is an error');
}
// --- duplicate chapter slug + number
{
  const c = structuredClone(good);
  c.books[0].chapters.push({n: 1, slug: 'ch-a', title: 'dup', audio: null, slides: []});
  const p = validateCatalog(c);
  ok(errs(p).some(x => /duplicate chapter slug/.test(x.msg)), 'duplicate chapter slug is an error');
  ok(errs(p).some(x => /duplicate chapter number/.test(x.msg)), 'duplicate chapter number is an error');
}
// --- the iOS invariant: audio.url must not be a github.com link
{
  const c = structuredClone(good);
  c.books[0].chapters[0].audio.url = 'https://github.com/kmay89/audio_book/releases/download/media-grows/grows__ch-a.mp3';
  ok(errs(validateCatalog(c)).some(p => /GitHub/.test(p.msg)), 'a GitHub audio.url is a hard error');
}
// --- audio missing required fields / bad duration
{
  const c = structuredClone(good);
  c.books[0].chapters[0].audio = {file: 'x.mp3', url: 'media/x.mp3', duration: 0};
  ok(errs(validateCatalog(c)).some(p => /duration is 0/.test(p.msg)), 'zero duration is an error');
}
// --- duplicate referenced asset filename
{
  const c = structuredClone(good);
  c.books[0].chapters[1].audio = {file: 'grows__ch-a.mp3', url: 'media/grows__ch-a.mp3', duration: 50};
  ok(errs(validateCatalog(c)).some(p => /referenced twice/.test(p.msg)), 'a filename referenced twice is an error');
}
// --- releaseTag mismatch is a warning, not an error
{
  const c = structuredClone(good); c.books[0].releaseTag = 'media-wrong';
  const p = validateCatalog(c);
  ok(!hasErrors(p) && p.some(x => x.level === 'warn' && /releaseTag/.test(x.msg)), 'releaseTag mismatch warns only');
}

// --- status dashboard renders the fill state
{
  const md = statusMarkdown(good);
  ok(md.includes('Everything That Grows'), 'status lists the book');
  ok(/1\/2/.test(md), 'status shows 1/2 audio filled');
  ok(md.includes('1 pages'), 'status shows slide page count');
}

console.log(fail ? `\n${fail} FAILURES` : '\nall catalog tests passed');
process.exit(fail ? 1 : 0);
