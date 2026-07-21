# Roadmap — the living backlog

The continuous-improvement queue. Add candidates with a one-line rationale;
move them to *Shipped* when done; record rejected ideas so they aren't
re-litigated. Process: see "Continuous improvement" in `CLAUDE.md` and the
change checklist in `GETTING-STARTED.md`.

## Next (high value / low cost)

- **Sources tab** — surface each chapter's citations in the player. Pipeline
  already supports it shape-wise: an `<book>__<slug>__sources.md` companion →
  tab beside Outline/Text. Stretch: an extractor that pulls per-chapter
  `Sources` blocks straight from the book repos so nothing is hand-copied.
- **Chapter-section markers** — a `<book>__<slug>__marks.txt` companion
  (`0:00 The candle problem` per line) → tick marks on the scrubber and a
  section list in Up Next. Cheap; makes 40-minute episodes navigable.
- **Journey parity with the readers** — per-book progress ring, milestone
  badges, and a one-time completion moment when all chapters are finished.
  Same gentle, streak-free ethos as the book sites.

## Later (worth it when the audience asks)

- **Podcast directory submission** — feeds are ready; submitting to Apple
  Podcasts Connect / Spotify for Creators yields canonical store links and
  search presence. Then: add `appleUrl`/`spotifyUrl` per book to the catalog
  and surface them first in the podcast chooser.
- **Synced read-along** (the moonshot) — highlight the Text tab as audio
  plays. Requires verbatim narration with timestamps (NotebookLM overviews
  are conversations *about* the text, so no timing data exists). If verbatim
  TTS editions are ever produced, timings come free and the Text tab is
  already the right surface.
- **Native car app** — only if demand appears: thin native wrapper
  (e.g. Capacitor) + Apple CarPlay audio entitlement + App Store review.
  The podcast feeds already cover car-screen browsing without it.
- **Per-book Media Session artwork sizes** — serve square cover crops at
  512/1024 for lock screens that prefer square art (currently the 2:3 cover
  is offered as-is and falls back to icons).

## Rejected (with reasons — don't re-litigate casually)

- **Accounts / cloud sync** — breaks the "nothing is tracked, nothing leaves
  the device" promise that the whole privacy story stands on. The backup file
  covers device migration.
- **Comments / social layer** — moderation burden, off-ethos. Sharing
  moments + flags covers the social impulse without hosting anyone's speech.
- **Streaks / gamified pressure** — against the series' gentle engagement
  philosophy. Progress and milestones yes; guilt mechanics no.
- **Serving audio from GitHub release URLs directly** — tried; iOS Safari
  refuses `application/octet-stream` media. Netlify `/media/` is the fix;
  see GETTING-STARTED watch-outs.
- **Service worker caching of audio** — intercepting media/range requests
  breaks seeking (especially Safari). The SW stays shell-only.

## Shipped (newest first)

- Production health check + one-step publish + release manifest:
  `tools/healthcheck.mjs` (scheduled `healthcheck.yml`) fetches the live site
  and fails loudly if any audio/slide URL 404s, loses range support, or a feed
  breaks — a broken deploy is caught within hours, not by a listener.
  `organize.py --publish` does upload → sync dispatch → watch in one command.
  `tools/manifest.mjs` commits a SHA-256 snapshot of each release
  (`tools/manifests/`) for audit + clobber recovery. Pure cores unit-tested.
- Catalog guard rail + status dashboard: `tools/verify-catalog.mjs` fails CI and
  the sync if the catalog would publish something broken (dup slugs/assets,
  missing fields, a GitHub audio.url that iOS can't play); `tools/status.mjs`
  regenerates `STATUS.md` (whole-library fill state) on every publish. Shared
  `lib-catalog.mjs`, unit-tested.
- Staging desk (`tools/organize/organize.py`): dump a book's raw media into one
  inbox and it renames to convention while reconciling against the live release
  — SHA-256 dedup (never re-uploads an identical file), REPLACE detection with
  the exact delete-first set, per-chapter fill status, refuses to guess; pure
  matcher, unit-tested in CI. Also inspects each file's bytes: magic-number type
  check, measured audio duration (shown + compared to the published length),
  empty/truncated detection, and duplicate-content-under-another-name — a failed
  integrity check holds the file back from any rename or upload
- First-visit "Add to Home Screen" nudge: one gentle, dismissible sheet on
  mobile (Apple = Share→Add steps; Android/Chrome = one-tap Install via
  `beforeinstallprompt`), delayed so it never lands on arrival, shown once
  (`ab-a2hs`), with a reassuring line about quiet auto-updates and
  on-device data
- Listening laps: finishing a chapter counts a play-through (`ab-laps`);
  relistening starts fresh while the ✓ stays, rows show "✓ ×N", the data
  panel totals listens, and restore merges lap counts by max — no streaks,
  just a quiet count
- Fullscreen slide lightbox: tap a slide (or the expand chip) for an
  iOS-Photos-style view — pinch to zoom about the pinch point, one-finger
  pan while zoomed, swipe to page at 1x, pull down or Esc to close,
  double-tap zoom; portrait-first, audio uninterrupted
- Embedded slides viewer: PDF decks are auto-rasterized to per-page images
  in CI and shown as a swipeable pager (counter, arrows, deck download) in
  the drawer's Slides tab and the Slides overlay
- Share-link importer: paste a song/share URL into the "Import from share
  link" workflow → dry-run quality report, then audio + artwork uploaded,
  transcoded, and synced in one go
- Workflow docs (GETTING-STARTED), committed test suite, CI on every push/PR
- One-tap subscribe links into native podcast apps (Apple Podcasts/Overcast/
  Pocket Casts) + per-book podcast RSS feeds; real cover art in Media Session
  (CarPlay/Android Auto/lock screen)
- Flags with jotted thoughts tied to timestamps; share-this-moment links that
  open cued to the second
- Native-feel icon controls (Apple-first, `data-os` hint); true 2:3 cover
  plates with edge-to-edge art
- Data durability: storage persistence request, live "Your data" status,
  backup/restore with furthest-point merge
- Back navigation (history + Show-in-book + Up Next), equalizer/progress
  micro-polish, wide two-pane Now Playing, volume/AirPlay
- Apple Books-style shelf, iOS share card, in-app legal pages (audio never
  stops), PWA auto-update + `navigate-existing`
- Now Playing drawer with Art/Slides/Outline/Text companions, wake lock
- Netlify-served media (iOS fix), CI transcode of any upload to 128k MP3,
  single-underscore filename tolerance
- The library, player, pipeline, legal/privacy/accessibility layer, domain
