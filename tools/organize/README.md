# The staging desk — `organize.py`

Dump a book's raw media into one folder and let the script rename it into the
release convention **meticulously**: it knows what's already published versus
what's still pending, never duplicates, and refuses to guess.

## Use it

```sh
# 1. dump this book's files into its inbox (created on first run)
open tools/organize/inbox/grows/        # drop 1.m4a, 1.pdf, "1 chart.png", 2.m4a …

# 2. see the plan — safe, changes nothing
python3 tools/organize/organize.py grows

# 3. do the renames
python3 tools/organize/organize.py grows --apply

# 4. run the two commands it prints (upload + sync)
```

Naming your files (any one of these — the script needs an unambiguous signal,
which is exactly why it can be 100% accurate):

- **a leading chapter number**: `1.m4a`, `07 deck.pdf`, `7 infographic.png`
- **already the convention**: `grows__ch-chance.m4a` (so re-runs are safe)
- **a `map.csv`** dropped in the inbox for arbitrary names:
  ```
  final-mix.m4a,16
  cathedral-deck.pdf,ch-cathedral
  ```

File types are read from the extension: audio (`.mp3/.m4a/.wav/.aac/.ogg/.opus`),
a slide deck (`.pdf`), slide images (`.png/.jpg/.jpeg/.webp`, numbered per chapter
in name order), and `…outline.txt` / `…text.md` companions.

## What each status means

The tool reconciles three sources of truth — `catalog.json` (which chapters
exist and what the player shows), the **media release** (what's actually
uploaded, with GitHub's SHA-256 digests), and your inbox (hashed locally):

| status | meaning | action |
|---|---|---|
| **NEW** | the chapter's slot is empty | renamed, included in the upload command |
| **DUPLICATE** | a byte-identical file is already uploaded | skipped — never re-uploaded |
| **REPLACE** | the slot is filled with *different* content | only with `--replace`; it prints the exact old assets to delete first (a new audio clears the derived `.mp3`; a new deck clears the whole slide-image set) so nothing goes stale |
| **UNMATCHED** | no clear chapter signal or unknown type | left untouched and listed |
| **CONFLICT** | two files want the same target | left untouched and listed |

Nothing filled is ever overwritten without `--replace`, and no ambiguous file
is ever renamed on a guess.

## Integrity checks (it looks *inside* each file)

Beyond matching, it opens every file to catch a wrong / corrupt / half-loaded
one before it can be renamed or uploaded:

- **Real type, not just extension** — magic-number sniff. A PDF saved as
  `.m4a`, or bytes that are `m4a` under a `.mp3` name, are an **ERROR**.
- **Empty / truncated** — a 0-byte file (failed copy), or audio that won't
  decode, or a PDF with no end marker → **ERROR** (audio) / **warn** (pdf).
- **Length is measured** — audio duration is parsed and shown (`[41:12]`), so a
  mis-numbered file jumps out; suspiciously short audio warns. On a `--replace`
  it compares against the **published** length and flags a big change.
- **Duplicate content, not just duplicate names** — SHA-256 catches a file
  that's identical to another in the batch, or already uploaded under a
  different name (e.g. the same audio dropped in for two chapters).

Files with an **ERROR** are listed and **held back** — never renamed, never in
the upload command. Warnings are shown but don't block. Each plan line shows
`[duration · pages · chapter title]` so you can eyeball it.

## Flags

- `--apply` perform the renames (default is a plan only)
- `--replace` also handle chapters whose slot is already filled
- `--publish` after `--apply`, upload via `gh` + dispatch the sync + watch it
  finish — the whole thing in one command (needs `gh` installed and authed)
- `--offline` skip the release lookup (no duplicate/replace detection)
- `--inbox <dir>` use a different folder

The truly hands-off run: `python3 tools/organize/organize.py grows --apply --publish`
— renames, uploads, fires the sync, and reports back when the chapter is live.

`GITHUB_TOKEN` is optional (rate limits / private repos). The inbox is
gitignored — media never enters the repo.

## Tests

`python3 tools/organize/test_organize.py` — the matcher's logic is pure and
covered (new / duplicate-by-hash / replace-with-delete-set / out-of-range /
conflict / map.csv / idempotent re-run). CI runs it on every push.

This supersedes `tools/rename-batch.mjs` for the careful workflow; that older
helper still exists for a quick number-only rename with no release awareness.
