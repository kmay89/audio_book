# The Everything Library — hear-my-book.com

> **New here? Read `GETTING-STARTED.md`** — the step-by-step publishing guide
> with the watch-outs. `PUBLISHING.md` is the pipeline reference, `ROADMAP.md`
> the living improvement backlog, `CLAUDE.md` the working conventions and
> invariants, and `tests/` the suite CI runs on every push.

The library and audio home of the *Everything* series by Karl Meves — a small
static site that showcases every book (read links, EPUB downloads) and serves
chapter-by-chapter audio (NotebookLM-generated episodes), plus any slides or
infographics that come with them, for:

- *Everything That Glows* — information is physical
- *Everything That Grows* — the oldest language
- *Everything That Knows* — the last question
- *Everything That Shows* — the weight of looking
- *Everything That Goes* — book five, in the works (audio previews can be
  published before the text: upload to `media-goes` and they appear as
  extras; when the book is published, fill in its `chapters` and `readUrl`
  in `catalog.json`)

The player remembers each listener's position per chapter (on-device,
`localStorage`, nothing tracked), shows chapter length and outline, supports
play/pause/seek, ±15/30s skips, playback speed, a sleep timer, auto-advance,
and drives the **lock screen / Bluetooth / headphone controls** via the Media
Session API. Chapters without audio yet link straight to the book's text, so
readers can always choose to read or listen.

## How it works

```
catalog.json      what exists: 4 books × chapters, each with audio/outline/slides
index.html        the player (single file, no dependencies, PWA)
tools/sync.mjs    wires GitHub Release assets into catalog.json
```

**The media lives in GitHub Releases on this repo** — one rolling release per
book, tagged `media-glows`, `media-grows`, `media-knows`, `media-shows`.
Release assets are free storage, up to 2 GB per file. At deploy time, Netlify's
build step (`tools/fetch-media.mjs`) pulls every file referenced by
`catalog.json` into `media/` and serves it same-origin with a real audio MIME
type and byte-range support — required because GitHub forces release downloads
to `application/octet-stream`, which iOS Safari refuses to play in an `<audio>`
element. Listening bandwidth therefore flows through Netlify (free tier:
100 GB/month ≈ ~2,600 full 40-minute chapter plays); if traffic ever outgrows
that, point the sync's `url` field at an R2/S3 bucket with free egress — the
player only follows the catalog.

## Publishing a new episode (the pipeline)

1. **Generate** the audio in NotebookLM and download the file.
2. **Rename** it to the convention `<book>__<chapter-slug>.mp3`, e.g.
   `glows__ch-remembers.mp3`. Chapter slugs are the `ch-…` ids from each book
   (they're all listed in `catalog.json`). A slug that isn't a chapter becomes
   an "extra" — e.g. `glows__overview.mp3` for a whole-book Audio Overview.
   (A single underscore, `glows_ch-remembers.mp3`, is tolerated for plain
   audio files — but the double underscore is the canonical form and required
   for `__outline` / `__slides` companions.)
3. **Upload** it to the book's media release on github.com → Releases →
   `media-<book>` → *Edit* → drag the file into the assets box. (First time:
   create a release with that tag — `media-glows` etc.)
4. **Run the sync**: Actions → *Sync catalog from releases* → *Run workflow*
   (it also runs daily on its own). It reads the file's real duration, updates
   `catalog.json`, and commits — Netlify redeploys and the episode is live,
   linked to its chapter.

Optional companions, same drag-and-drop, matched by filename:

| file | shows up as |
|---|---|
| `glows__ch-remembers__outline.txt` (or `.md`) | the chapter's expandable outline |
| `glows__ch-remembers__text.md` (or `.txt`) | a read-along Text tab in the Now Playing view |
| `glows__ch-remembers__slides.pdf` | "Slides" button (opens the PDF) |
| `glows__ch-remembers__slide-01.png`, `-02` … | "Slides" button (inline images) |

`.m4a`, `.wav`, and friends are accepted too — the sync workflow first
**normalizes** any non-MP3 audio (CI transcodes it to a web-safe 128 kbps MP3
with ffmpeg and uploads it back to the release; the original stays put and the
catalog uses the MP3). So upload exactly what NotebookLM gives you. Deleting a
chapter's assets from the release and re-running the sync unwires it again —
the releases are the source of truth.

Locally, the same sync runs with `node tools/sync.mjs` (add `--dry-run` to
preview; set `GITHUB_TOKEN` if you hit API rate limits).

## In the car (CarPlay / Android Auto)

Playback uses a real media stream with full Media Session metadata, so when
a phone is connected to a car the audio routes as proper media: it ducks for
navigation prompts, pauses for calls, shows the **book cover, chapter title,
and progress** on the car's Now Playing screen, and steering-wheel /
lock-screen controls work. Start playback on the phone; the car takes it
from there.

Web apps cannot appear as apps *on* the car screen (Apple and Google only
allow approved native apps). For car-screen browsing, every book with audio
publishes a standard **podcast feed** (`/feed-<book>.xml`, generated at
deploy by `tools/build-feeds.mjs`) — add it to Apple Podcasts, Overcast, or
any podcast app and the chapters get a native CarPlay / Android Auto
interface for free. The feeds can also be submitted to podcast directories
whenever that's wanted.

## Player URLs

- `/` — library
- `/#glows` — one book's chapter list
- `/#glows/ch-remembers` — deep link that cues a chapter (this is the link
  format the book sites can use for a "Listen" button per chapter)

## Development

No build step. `python3 -m http.server` in the repo root, open
`http://localhost:8000`. `tools/` is stdlib-only (Node 20+): `duration.mjs`
parses MP3/M4A/WAV lengths, `make-icons.mjs` regenerates the PWA icons.
Bump `CACHE` in `sw.js` when shipping player changes so installed copies
refresh. Audio is intentionally never cached by the service worker —
intercepting media range requests breaks seeking.

## Publishing

`PUBLISHING.md` documents the full Errerlabs pipeline — episode loop, adding a
new book, EPUB releases, legal defaults, domain setup, and the launch
checklist.

## Author / publisher

By **Karl Meves**, published by **Errerlabs** (errerlabs@gmail.com).
Site, books, audio: all rights reserved — see `LICENSE` and `legal.html`.
