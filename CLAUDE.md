# CLAUDE.md

Guidance for working in this repository.

## What this is

**hear-my-book.com** — The Everything Library: the audio home and shelf for
the *Everything* series by Karl Meves (published by Errerlabs). A single-file
static web player plus a drag-and-drop publishing pipeline that turns
NotebookLM audio into per-chapter episodes with slides, outlines, read-along
text, flags/thoughts, podcast feeds, and CarPlay/Android Auto-correct
playback. No frameworks, no dependencies in anything served; tooling is
stdlib-Node except tests (playwright).

Docs: `GETTING-STARTED.md` (step-by-step + watch-outs — **read it first**),
`PUBLISHING.md` (pipeline reference), `tests/README.md`.

## Layout

- `index.html` — the entire app: shelf (Apple Books-style covers), book view,
  mini player, Now Playing drawer (Art/Up Next/Slides/Outline/Text/Flags
  tabs), Aa panel (theme, text size, backup/restore), in-app legal pages.
  One file, inline CSS+JS, theme-aware, `data-os` platform hint.
- `catalog.json` — source of truth for books/chapters/metadata. Machine-owned
  blocks (`audio`, `slides`, `text`, `outlineFromAsset`) are written by the
  sync; everything else is human-owned. Ownership table in GETTING-STARTED.
- `tools/` — `sync.mjs` (release assets → catalog; runs in Actions),
  `normalize.mjs` (ffmpeg transcode to 128k MP3 in CI), `slides.mjs`
  (PDF decks → per-page slide images in CI), `fetch-media.mjs` +
  `build-feeds.mjs` (Netlify build steps), `duration.mjs` (stdlib MP3/M4A/WAV
  parsers), `make-icons.mjs` / `make-og.mjs` (asset regeneration).
- `.github/workflows/` — `sync-catalog.yml` (normalize + sync, dispatch/daily),
  `ci.yml` (tests on every push/PR).
- `tests/` — `duration.test.mjs` (units), `run.mjs` (85-assertion Playwright
  e2e), tiny fixtures.
- `media/`, `feed-*.xml` — **build artifacts, gitignored, never commit.**
- Standalone pages: `privacy.html`, `legal.html`, `accessibility.html`,
  `404.html` — hand-maintained, share the app's `ab-theme`/`ab-textsize` keys.
- `sw.js` — shell-only service worker; `manifest.webmanifest`; icons;
  `og-image.png`; `netlify.toml` (headers/CSP/redirects/build command).

## Invariants (break these and real things break)

- **The repo stays public.** Release assets must be publicly fetchable.
- **Audio reaches listeners only via `/media/`** (Netlify-served). GitHub
  release URLs are `application/octet-stream` — iOS Safari refuses them.
- **The service worker never intercepts `/media/` or ranged requests**, and
  `CACHE` in `sw.js` gets bumped on every player-affecting change.
- **Chapter slugs are identity** (filenames, positions, flags, share links,
  feed GUIDs). Don't rename them; don't change the GUID scheme
  (`hear-my-book:<book>/<slug>`).
- **Listener data is sacred**: `ab-*` localStorage keys; positions per
  chapter; `ended` clears position + marks done + counts a lap (`ab-laps`);
  restore merges positions by furthest point and laps by highest. Audio must
  keep playing across all in-app navigation.
- **Served code is dependency-free** and CSP-locked (`netlify.toml`); no
  external scripts, no CDNs. Media/img allowances are deliberate.
- `media-<slug>` release **tags** are pipeline addresses — assets change
  freely, tags don't.

## Working notes

- **Editing the player** = editing `index.html` (prefer targeted `Edit`s; the
  file is large). Keep aria labels, focus states, `prefers-reduced-motion`
  fallbacks, and `[hidden]` semantics. Favor Apple design; `data-os` exists
  for platform nuance.
- **After editing**: run `node tests/duration.test.mjs`, then
  `cd tests && npm install && node run.mjs` (set `CHROMIUM=` to reuse a local
  browser). Add assertions for new behavior — the suite is the contract.
  Bump `sw.js` `CACHE`. CI must be green.
- **Ship flow**: branch → PR → CI green → merge → Netlify auto-deploys
  (build = fetch-media + build-feeds). The Sync workflow commits catalog
  changes to main directly; that's expected.
- **Publishing content** is not a code task: see GETTING-STARTED (upload to
  the book's `media-*` release, run the Sync workflow).
- **Author/publisher**: Karl Meves / Errerlabs (errerlabs@gmail.com) — keep
  that split consistent across footers, JSON-LD, LICENSE, legal.html, feeds.
- All rights reserved (see `LICENSE`); AI-narration disclosure lives in
  `legal.html` and the feeds' descriptions. Keep both truthful.

## Continuous improvement

`ROADMAP.md` is the living backlog — candidate features with rationale and
rough cost, plus what was deliberately rejected (and why), so ideas aren't
re-litigated. The improvement loop, in short: pick from the roadmap (or add
to it with a one-line rationale) → build behind the invariants above → extend
`tests/run.mjs` with assertions for the new behavior → update
GETTING-STARTED/PUBLISHING if the workflow changed → PR with CI green →
verify once on a real phone after deploy. Definition of done includes docs
and tests, not just code.
