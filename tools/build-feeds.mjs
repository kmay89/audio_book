#!/usr/bin/env node
// Generate a standard podcast RSS feed per book (feed-<slug>.xml) from
// catalog.json. Runs as part of the Netlify build, after fetch-media.mjs.
//
// Why: podcast apps (Apple Podcasts, Overcast, Pocket Casts, …) have real
// CarPlay and Android Auto interfaces. Web apps cannot appear on car screens,
// so the feeds are the zero-app-store way to browse and play the chapters
// from the car. The website stays the rich home; the feed is a doorway.
//
// Usage: node tools/build-feeds.mjs

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const SITE = (catalog.siteUrl || 'https://hear-my-book.com').replace(/\/$/, '');

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));
const abs = u => /^https?:/i.test(u) ? u : `${SITE}/${u.replace(/^\//, '')}`;
const rfc822 = iso => new Date(iso || catalog.updated).toUTCString();

let built = 0;
for (const book of catalog.books){
  const items = [...(book.extras || []), ...book.chapters].filter(x => x.audio);
  if (!items.length) continue;

  const episodes = items.map(it => `
    <item>
      <title>${esc(it.n != null ? `${it.n}. ${it.title}` : it.title)}</title>
      <guid isPermaLink="false">${esc('hear-my-book:' + book.slug + '/' + it.slug)}</guid>
      <link>${esc(SITE + '/#' + book.slug + '/' + it.slug)}</link>
      <enclosure url="${esc(abs(it.audio.url))}" length="${it.audio.bytes}" type="audio/mpeg"/>
      <pubDate>${rfc822(it.audio.updated)}</pubDate>
      <itunes:duration>${it.audio.duration}</itunes:duration>
      ${it.outline ? `<description>${esc(it.outline)}</description>` : `<description>${esc(`“${it.title}” from ${book.title} by ${book.author} — AI-narrated audio edition.`)}</description>`}
      <itunes:explicit>false</itunes:explicit>
    </item>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(book.title)}</title>
    <link>${esc(SITE + '/#' + book.slug)}</link>
    <atom:link href="${esc(SITE + '/feed-' + book.slug + '.xml')}" rel="self" type="application/rss+xml"/>
    <language>en</language>
    <copyright>© ${new Date().getFullYear()} ${esc(book.author)} · Published by ${esc(catalog.publisher || 'Errerlabs')}</copyright>
    <description>${esc((book.description || book.tagline || book.title) + ' AI-narrated audio edition, chapter by chapter. Read the full book at ' + (book.readUrl || SITE) + '.')}</description>
    <itunes:author>${esc(book.author)}</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="Arts"><itunes:category text="Books"/></itunes:category>
    ${book.coverUrl ? `<itunes:image href="${esc(abs(book.coverUrl))}"/>` : `<itunes:image href="${esc(SITE + '/icon-512.png')}"/>`}
    ${episodes}
  </channel>
</rss>
`;
  fs.writeFileSync(path.join(ROOT, `feed-${book.slug}.xml`), xml);
  console.log(`feed-${book.slug}.xml (${items.length} episode${items.length === 1 ? '' : 's'})`);
  built++;
}
console.log(built ? `${built} feed(s) built.` : 'no books with audio yet — no feeds built.');
