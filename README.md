# Everything, Read Aloud

The audio companion to the *Everything* series by Karl Meves — a small static
web player that serves chapter-by-chapter audio (NotebookLM-generated episodes),
plus any slides or infographics that come with them, for:

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
Release assets are free to host, up to 2 GB per file, and (verified) served
with HTTP range support, so scrubbing and resume work in every browser.
The player streams them directly; nothing is re-hosted.

## Publishing a new episode (the pipeline)

1. **Generate** the audio in NotebookLM and download the file.
2. **Rename** it to the convention `<book>__<chapter-slug>.mp3`, e.g.
   `glows__ch-remembers.mp3`. Chapter slugs are the `ch-…` ids from each book
   (they're all listed in `catalog.json`). A slug that isn't a chapter becomes
   an "extra" — e.g. `glows__overview.mp3` for a whole-book Audio Overview.
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
| `glows__ch-remembers__slides.pdf` | "Slides" button (opens the PDF) |
| `glows__ch-remembers__slide-01.png`, `-02` … | "Slides" button (inline images) |

`.m4a` and `.wav` audio are accepted too, but `.mp3` is the safe default for
every browser. Deleting an asset from the release and re-running the sync
unwires it again — the releases are the source of truth.

Locally, the same sync runs with `node tools/sync.mjs` (add `--dry-run` to
preview; set `GITHUB_TOKEN` if you hit API rate limits).

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

## Author / publisher

By **Karl Meves**, published by **Errerlabs** (errerlabs@gmail.com).
The books are free to read at their own sites; see each book repo's LICENSE.
