# How Errerlabs publishes — the pipeline

This repository is the publishing pipeline for **hear-my-book.com** (The
Everything Library): the place where finished text becomes a public book page
with a read link, an EPUB, and chapter-by-chapter AI-narrated audio. It is
designed so that publishing anything is a drag-and-drop, and everything else
— durations, catalog, deploys — is automatic.

## The moving parts

| piece | where | job |
|---|---|---|
| the text | each book's own repo + site (`everythingthatglows.com`, …) | canonical work, EPUB releases |
| the media | GitHub Releases on this repo, tag `media-<book>` | audio episodes, slides, outlines |
| the catalog | `catalog.json` | what exists, wired together |
| the library | `index.html` on hear-my-book.com | the public face: read, listen, download |
| the sync | `tools/sync.mjs` + the *Sync catalog* workflow | turns uploaded assets into catalog entries |

## Publish an audio episode (the 4-step loop)

1. **Generate** the narration (e.g. NotebookLM) and download the file.
2. **Rename** by convention: `<book>__<chapter-slug>.mp3` — e.g.
   `glows__ch-remembers.mp3`. Slugs live in `catalog.json`. A slug that isn't
   a chapter becomes an "extra" (`glows__overview.mp3`).
3. **Upload**: github.com → Releases → `media-<book>` → *Edit* → drag the file
   into the assets box. Companions ride along by filename:
   `…__outline.txt`, `…__slides.pdf`, `…__slide-01.png` ….
4. **Sync**: Actions → *Sync catalog from releases* → *Run workflow* (a daily
   run is the backstop). It reads real durations, updates `catalog.json`,
   commits, and Netlify redeploys. Done — the episode is live, linked to its
   chapter, with length shown and position memory for every listener.

Removing an asset from the release and re-syncing unpublishes it. The
releases are the source of truth for media.

## Add a new book to the library

1. Add a book object to `catalog.json`: `slug`, `title`, `tagline`, `author`,
   `description`, `order`, accent colors, `releaseTag: "media-<slug>"` —
   plus `readUrl`/`epubUrl` once the book has a site and a release, or
   `null` while it's in the works (the library shows it as "coming soon" and
   audio previews already work).
2. When the text is published, fill in `chapters` (`n`, `slug`, `title` —
   the `ch-…` ids from the book's site so read-links and audio line up) and
   the `readUrl`/`epubUrl`.
3. Create the `media-<slug>` release and start the 4-step loop above.

## Cut an EPUB release (per book repo)

Each book repo builds its own EPUB in CI and publishes it on a `v*` tag
(`git tag vX.Y.Z && git push origin vX.Y.Z`). The library's EPUB buttons
point at `releases/latest/download/<file>.epub`, so cutting a release
updates the button automatically. If a book's EPUB button 404s, that repo
simply hasn't cut a tagged release yet.

## The legal defaults (every Errerlabs publication)

- **Copyright line**: © Karl Meves · Published by Errerlabs. All rights
  reserved. (`LICENSE`, site footer, `legal.html`.)
- **AI-narration disclosure**: audio editions are AI-narrated from the
  author's text; voices are synthetic; the written text is canonical.
  (`legal.html`, LICENSE.)
- **Privacy posture**: no accounts, no analytics, no cookies; listener state
  is on-device only. (`privacy.html`.)
- **Accessibility statement** with a real contact. (`accessibility.html`.)
- **Security policy** with private reporting. (`SECURITY.md`.)

## Site & domain

- Netlify serves this repo's root; `netlify.toml` carries the headers, CSP,
  service-worker rules, and the `www.hear-my-book.com → hear-my-book.com`
  redirect. The only build step is `tools/fetch-media.mjs`, which downloads
  the catalog's media out of GitHub Releases so Netlify serves it with real
  audio MIME types (GitHub's forced `octet-stream` downloads don't play on
  iOS Safari). Media bandwidth rides Netlify's 100 GB/month free tier; the
  scale-up path is an R2/S3 bucket with free egress, swapped in via the
  catalog's `url` fields.
- Custom domain: add `hear-my-book.com` under Site → Domain management and
  follow Netlify's DNS instructions (apex A/ALIAS + `www` CNAME); HTTPS is
  automatic.
- After changing the player shell, bump `CACHE` in `sw.js` so installed
  copies refresh.

## Launch checklist (new site from this template)

- [ ] Catalog seeded (books, chapters, descriptions, accents)
- [ ] Icons generated (`node tools/make-icons.mjs`)
- [ ] Canonical URL set in `index.html`, `robots.txt`, `sitemap.xml`,
      `netlify.toml` redirect, JSON-LD
- [ ] `LICENSE`, `legal.html`, `privacy.html`, `accessibility.html`,
      `SECURITY.md` reviewed
- [ ] Netlify project created, custom domain attached, HTTPS issued
- [ ] First `media-*` release created, first episode uploaded, sync run
- [ ] Playwright suite green (`test-player.mjs` — see repo history)
