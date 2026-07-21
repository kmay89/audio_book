// Shared catalog helpers for the guard rails: enumerate the media a catalog
// references, and validate the catalog's own integrity. Pure (no I/O) so the
// verifier, the health check, and the status dashboard all agree and are
// testable without the network.

// Every media asset the player would try to load, flattened across books,
// chapters, and extras.
export function referencedAssets(catalog){
  const out = [];
  for (const b of catalog.books || []){
    const items = [...(b.chapters || []), ...(b.extras || [])];
    for (const it of items){
      const where = `${b.slug}/${it.slug}`;
      if (it.audio && it.audio.file)
        out.push({book: b.slug, where, kind: 'audio', ...it.audio});
      for (const s of it.slides || [])
        if (s.file) out.push({book: b.slug, where, kind: 'slides', ...s});
      if (it.text && it.text.file)
        out.push({book: b.slug, where, kind: 'text', ...it.text});
    }
  }
  return out;
}

// Structural + invariant checks. Returns [{level:'error'|'warn', msg}]. An
// error means the catalog would publish something broken; the verifier fails
// CI on any error so a bad state can't reach production.
export function validateCatalog(catalog){
  const problems = [];
  const err = msg => problems.push({level: 'error', msg});
  const warn = msg => problems.push({level: 'warn', msg});

  if (!catalog || typeof catalog !== 'object') { err('catalog is not an object'); return problems; }
  if (!catalog.siteUrl) err('missing siteUrl');
  if (!catalog.mediaRepo) err('missing mediaRepo');
  if (!Array.isArray(catalog.books)) { err('books is not an array'); return problems; }

  const bookSlugs = new Set();
  for (const b of catalog.books){
    if (!b.slug) { err('a book has no slug'); continue; }
    if (bookSlugs.has(b.slug)) err(`duplicate book slug: ${b.slug}`);
    bookSlugs.add(b.slug);
    if (!/^[a-z0-9-]+$/.test(b.slug)) err(`book slug is not url-safe: ${b.slug}`);
    if (b.releaseTag && b.releaseTag !== `media-${b.slug}`)
      warn(`${b.slug}: releaseTag is "${b.releaseTag}", expected "media-${b.slug}"`);

    const chSlugs = new Set(), chNums = new Set();
    for (const c of b.chapters || []){
      if (!c.slug) { err(`${b.slug}: a chapter has no slug`); continue; }
      if (chSlugs.has(c.slug)) err(`${b.slug}: duplicate chapter slug ${c.slug}`);
      chSlugs.add(c.slug);
      if (c.n != null){
        if (chNums.has(c.n)) err(`${b.slug}: duplicate chapter number ${c.n}`);
        chNums.add(c.n);
      }
      if (c.audio) validateAudio(`${b.slug}/${c.slug}`, c.audio, err, warn);
      (c.slides || []).forEach((s, i) => {
        if (!s.file || !s.url) err(`${b.slug}/${c.slug}: slide ${i + 1} missing file/url`);
      });
    }
  }

  // every referenced asset filename must be unique (a collision means one of
  // them silently shadows the other in /media/)
  const seen = new Map();
  for (const a of referencedAssets(catalog)){
    if (seen.has(a.file)) err(`asset "${a.file}" is referenced twice (${seen.get(a.file)} and ${a.where})`);
    else seen.set(a.file, a.where);
  }
  return problems;
}

function validateAudio(where, a, err, warn){
  for (const f of ['file', 'url', 'duration'])
    if (a[f] == null) err(`${where}: audio missing ${f}`);
  if (a.url && /^https?:\/\/(www\.)?github\.com/.test(a.url))
    err(`${where}: audio.url points straight at GitHub — iOS Safari refuses octet-stream media; it must be served from /media/`);
  else if (a.url && !a.url.startsWith('media/'))
    warn(`${where}: audio.url is not under media/ (${a.url})`);
  if (a.duration != null && !(a.duration > 0))
    err(`${where}: audio.duration is ${a.duration}`);
}

export function hasErrors(problems){
  return problems.some(p => p.level === 'error');
}
