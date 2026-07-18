# Getting started — publish audio for a book, step by step

This is the practical guide to hear-my-book.com: how to publish an episode,
add companions, add a book, edit safely, and what to watch out for.
For the architecture reference see `PUBLISHING.md`; for the repo map, `README.md`.

## How the system fits together (60 seconds)

```
 NotebookLM (or any audio)             you drag & drop
        │                                    │
        ▼                                    ▼
 GitHub Release  ──────────────►  "Sync catalog" workflow (Actions)
 tag: media-<book>                • transcodes non-MP3 → 128k MP3 (ffmpeg)
 = the upload box                 • measures real durations
 = permanent storage              • updates catalog.json, commits
                                             │
                                             ▼
                              Netlify build (automatic on commit)
                              • downloads catalog media → /media/*
                              • generates podcast feeds → /feed-*.xml
                                             │
                                             ▼
                       hear-my-book.com — the library, player, feeds
```

Two ideas to hold on to:

1. **Releases are the source of truth for media.** Upload there, delete there;
   the sync makes the catalog follow.
2. **`catalog.json` is the source of truth for everything else** — titles,
   descriptions, covers, chapter lists, order. Some blocks inside it are
   machine-written (see [Who owns what](#who-owns-what-in-catalogjson)).

---

## Publish an episode (the everyday loop)

1. **Generate & download** the audio (NotebookLM → download). Any of
   `.mp3 .m4a .wav .aac .ogg .opus` is fine — CI normalizes to MP3.
2. **Rename** to the convention:
   `<book>__<chapter-slug>.<ext>` — e.g. `grows__ch-cathedral.m4a`.
   - Book and chapter slugs are in `catalog.json`.
   - Double underscore `__` is canonical. A single `_` between book and
     chapter is tolerated everywhere (audio and companions), but don't rely
     on it — the double is what every example and tool prints.
   - A slug that isn't a chapter becomes an "extra" (e.g. `grows__overview.mp3`
     for a whole-book Audio Overview) — extras appear in an "Overviews &
     extras" section and in Up Next.
3. **Upload**: github.com → the repo → Releases → `media-<book>` → *Edit* →
   drag the file into the assets box → *Update release*.
   (First time for a book: *Draft a new release*, tag exactly `media-<book>`.)
4. **Run the sync**: Actions → *Sync catalog from releases* → *Run workflow*.
   (A daily scheduled run is the backstop if you forget.)
5. **Wait ~2–4 minutes**, then check the site: the chapter shows its real
   duration and plays. Done.

**Bulk upload from the command line** (best for a whole book — browser
drag-and-drop gets fragile past a few hundred MB): name your files by
chapter **number** (`1.m4a`, `02 deck.pdf`, `5 infographic.png` …), then let
the repo rename and upload them:

```sh
git clone https://github.com/kmay89/audio_book && cd audio_book
node tools/rename-batch.mjs grows ~/Desktop/grows-files --dry-run   # preview
node tools/rename-batch.mjs grows ~/Desktop/grows-files             # rename
cd ~/Desktop/grows-files
gh release upload media-grows * --repo kmay89/audio_book --clobber  # upload
gh workflow run sync-catalog.yml --repo kmay89/audio_book           # publish
```

(`gh` is the GitHub CLI — `brew install gh`, then `gh auth login` once.
Never commit media into git; releases are the storage, `gh release upload`
is the truck. `--clobber` overwrites same-name assets.)

**Companions** ride in the same drag-and-drop, matched by filename:

| upload | becomes |
|---|---|
| `grows__ch-see__outline.txt` / `.md` | expandable outline + drawer Outline tab |
| `grows__ch-see__text.md` / `.txt` | read-along Text tab (light markdown: `##`, `**bold**`, `*italic*`) |
| `grows__ch-see__slides.pdf` | Slides button/tab (opens the PDF) |
| `grows__ch-see__slide-01.png` `-02` … | Slides as inline images, in number order |

**Replace** an episode: delete the old asset from the release, upload the new
file (same name), run the sync. **Unpublish**: delete the chapter's assets and
run the sync — the chapter reverts to "text only".

### Import straight from a share link (songs, generated audio)

For tools that give you a share page instead of a file (AI song generators
etc.): Actions → **Import from share link** → paste **one or more** share
URLs (space-separated) — or a **profile/listing page**, whose `/song/` links
are expanded automatically — and pick the destination book (the `songs`
album exists for music). Slugs derive from each song's title; already-imported
songs are skipped, so reruns are safe. Leave **publish** unchecked first —
the dry run reports every audio URL each page serves with its real size and
content type (that's how you check whether the share stream matches download
quality). Re-run with **publish** checked and it uploads the biggest audio +
each page's artwork (as `__slide-01`) to the release (creating the release if
needed), transcodes, and syncs — live in one go. If a page loads audio only
through authenticated APIs, the report says so; fall back to the tool's own
Download button and the normal upload.
Mind the generator's terms for rights over generated audio before publishing
publicly.

---

## Add a new book to the library

1. Add a book object to `catalog.json` (copy an existing one):
   - `slug` (short, no underscores — it prefixes every filename),
     `title`, `tagline`, `author`, `description`, `order`
   - `accent` / `accentBright` (the book's colors; used wherever there's no
     cover image)
   - `coverUrl` — a real 2:3 cover image URL (or `null` for the gradient plate)
   - `releaseTag`: `"media-<slug>"`
   - `readUrl` / `epubUrl` — or `null` while unpublished (the shelf shows
     "coming soon"; audio previews still work as extras)
   - `chapters`: `[]` until the text is final, then
     `{n, slug, title}` per chapter — **use the book site's real `ch-…` ids**
     so read-links and audio line up
2. Commit → Netlify deploys → the book is on the shelf.
3. Create the `media-<slug>` release and start the loop above.

## Editing chapters/text of an existing book

- Adding chapters later: append to `chapters` with the right `n` and slug.
- Renaming a chapter title: edit `title` in the catalog — safe anytime.
- **Changing a chapter slug**: avoid. It's the identity used by filenames,
  saved listener positions, flags, and share links. If you must, re-upload
  audio under the new name and accept that listeners' saved spots for that
  chapter reset.

---

## Who owns what in catalog.json

| field | owner | notes |
|---|---|---|
| `title, tagline, author, description, order, accent*, coverUrl, readUrl, epubUrl, chapters[].{n,slug,title}` | **you** | sync never touches these |
| `chapters[].audio`, `extras[].audio` | **sync** | url/bytes/duration/assetId — never hand-edit; your edits are overwritten |
| `slides`, `text` | **sync** | from release assets |
| `outline` | **both** | hand-written outlines are kept; an `__outline` asset overrides and tags itself `outlineFromAsset` so only asset-born outlines are auto-removed when the asset goes |
| `extras[].title` | you (after sync creates it) | sync auto-titles from the slug; your edit sticks |
| `updated`, `siteUrl`, `series` | you / sync (`updated`) | `series` drives the hero copy |

**Never hand-edit** `audio.url` to point at GitHub directly — GitHub serves
downloads as `application/octet-stream`, which **iOS Safari refuses to play**.
The `media/…` path exists precisely for that (see watch-outs).

---

## Watch-outs (the sharp edges)

**Repo & hosting**
- **The repo must stay public.** Private release assets can't be streamed and
  the Netlify build can't fetch them. The all-rights-reserved LICENSE is what
  protects the content, not repo privacy.
- **Never link audio at GitHub URLs in the player.** iOS refuses
  octet-stream audio. Audio must flow through Netlify's `/media/` (the build
  step handles this — just don't bypass it).
- `media/` and `feed-*.xml` are **build artifacts** — gitignored, regenerated
  every deploy. Don't commit them; don't put files there by hand.
- The Netlify build command must keep **both** steps:
  `node tools/fetch-media.mjs && node tools/build-feeds.mjs`.
- Don't rename or delete the `media-*` release **tags**. Assets inside can
  change freely; the tag is the pipeline's address.

**Editing the player (`index.html`)**
- After any player change, **bump `CACHE` in `sw.js`** (v4 → v5 → …) so
  installed home-screen copies refresh their offline shell.
- The service worker must **never intercept `/media/` or ranged requests** —
  that guard is in `sw.js`; keep it, or seeking breaks on Safari.
- Keep everything dependency-free and platform-standard. No frameworks, no
  CDNs — the CSP blocks external scripts by design.
- Honor the invariants tests assert: audio keeps playing across navigation,
  positions save on pause/hide/switch, `[hidden]` always wins, reduced-motion
  disables animation.
- **Run the tests** (below) before pushing. CI runs them on every push/PR.

**Listener data (treat as sacred)**
- All state is `localStorage` under `ab-*` keys. The backup file
  (`Aa → Back up`) is the migration path — never build anything that would
  require clearing site data without pointing users there first.
- Positions are per chapter; `ended` clears a chapter's position and marks it
  done. Restore merges positions by furthest-point. Keep those semantics.

**Feeds & car**
- Feeds regenerate on every deploy from the catalog — never edit `feed-*.xml`.
- Episode GUIDs are `hear-my-book:<book>/<slug>` — stable so podcast apps
  don't re-download; don't change the scheme.
- If you submit feeds to Apple/Spotify directories later, add the canonical
  store URLs to the catalog and surface them in the podcast chooser.

**Domain & pages**
- Canonical URLs live in several places; if the domain ever changes, update:
  `index.html` (canonical/og/JSON-LD), `robots.txt`, `sitemap.xml`,
  `netlify.toml` redirect, `catalog.json` `siteUrl`, and the standalone pages'
  canonicals.
- The standalone pages (privacy/legal/accessibility/404) are hand-maintained
  files sharing the app's theme keys — if you add a theme, update them too.

**Covers & art**
- `cover-web.jpg`-style images ~440×660 are ideal (2:3). The player never
  crops or overlays real covers; the gradient plate is the automatic fallback
  if a cover URL 404s.
- After changing covers/branding, regenerate the share card:
  `node tools/make-og.mjs` (needs playwright; see tests/README).

---

## Making changes — the continuous-improvement loop

Ideas live in **`ROADMAP.md`** (candidates with rationale, rejected ideas
with reasons, shipped history). When building anything, the loop is:

1. **Pick or add a roadmap item** — one line of rationale is enough. Check
   the *Rejected* list first so settled questions aren't reopened.
2. **Branch and build** within the invariants (`CLAUDE.md` lists them; the
   watch-outs above are the long form).
3. **Extend the tests.** New behavior gets assertions in `tests/run.mjs` —
   the suite is the product's contract, not an afterthought.
4. **Update the docs you just made stale**: this file if the workflow
   changed, `PUBLISHING.md` if the pipeline changed, `ROADMAP.md` always
   (move the item to Shipped).
5. **Bump `sw.js` `CACHE`** if the player changed.
6. **PR with CI green → merge** → Netlify deploys automatically.
7. **Verify once on a real device** — the iOS lessons in this repo's history
   were all invisible in desktop testing.

**Definition of done = code + tests + docs.** A change without the last two
isn't finished.

## Verifying your changes

```sh
# fast: duration parsers (no browser needed)
node tests/duration.test.mjs

# full: 85-assertion end-to-end player suite (needs Chromium via playwright)
cd tests && npm install && node run.mjs
```

CI (`.github/workflows/ci.yml`) runs both on every push and PR. Keep it green
— it's the guard that keeps the library unbreakable while you publish.

## Release checklist for a brand-new deployment of this kit

- [ ] Repo public; `media-*` releases created
- [ ] `catalog.json`: books seeded, `siteUrl` set, series block written
- [ ] Netlify project → repo, custom domain attached, HTTPS issued
- [ ] Icons + og-image generated (`tools/make-icons.mjs`, `tools/make-og.mjs`)
- [ ] LICENSE / legal / privacy / accessibility reviewed for the new identity
- [ ] First episode uploaded, sync run, played on a real iPhone
- [ ] Tests green in CI
