// Unit tests for the release-asset filename parser shared by sync + normalize.
import {parseName} from '../tools/sync.mjs';

let fail = 0;
const check = (name, want) => {
  const got = parseName(name);
  const ok = want === null
    ? got === null
    : got && got.book === want.book && got.slug === want.slug && got.extra === want.extra;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${JSON.stringify(got && {book: got.book, slug: got.slug, extra: got.extra})}`);
  if (!ok) fail++;
};

// canonical
check('grows__ch-see.mp3', {book: 'grows', slug: 'ch-see', extra: null});
check('grows__ch-see__slides.pdf', {book: 'grows', slug: 'ch-see', extra: 'slides'});
check('grows__ch-see__slide-01.png', {book: 'grows', slug: 'ch-see', extra: 'slide-01'});
check('grows__ch-see__outline.txt', {book: 'grows', slug: 'ch-see', extra: 'outline'});
check('songs__song-infinite-coastline__slide-01.png',
  {book: 'songs', slug: 'song-infinite-coastline', extra: 'slide-01'});

// single-underscore tolerance — plain audio and companions alike
check('grows_ch-see.m4a', {book: 'grows', slug: 'ch-see', extra: null});
check('grows_ch-see__slides.pdf', {book: 'grows', slug: 'ch-see', extra: 'slides'});
check('grows_ch-see__slide-02.png', {book: 'grows', slug: 'ch-see', extra: 'slide-02'});

// not parseable
check('noprefix.mp3', null);
check('_leading.mp3', null);

process.exit(fail ? 1 : 0);
