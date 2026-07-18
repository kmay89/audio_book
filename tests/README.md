# Tests

- `duration.test.mjs` — unit tests for the MP3/M4A/WAV duration parsers.
  No dependencies: `node duration.test.mjs`.
- `run.mjs` — the end-to-end player suite (85 assertions): composes a
  throwaway site from the repo + `fixtures/`, serves it with byte-range
  support, and drives it in Chromium. Run with:

      npm install
      node run.mjs

  Set `CHROMIUM=/path/to/chrome` to use an existing browser instead of
  playwright's download. CI runs both suites on every push/PR.

Fixtures are deliberately tiny: a generated 30-second tone stands in for
episodes; `catalog.test.json` models three books (with audio, text-only,
and unpublished-with-preview states).
