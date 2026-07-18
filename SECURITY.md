# Security policy

This project is a static website with no backend, no database, no user accounts,
and no collection of personal data. The attack surface is small, but reports are
still welcome and appreciated.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability.

1. **Preferred:** use GitHub's private vulnerability reporting for this
   repository (the **Security → Report a vulnerability** tab). This keeps the
   report confidential until a fix is ready.
2. **Alternative:** email **errerlabs@gmail.com** with the details.

Include what you found, where (file/URL), and how to reproduce it. Good-faith
reports are answered promptly, and fixes are published as soon as they are
ready.

## Scope notes

- The site ships a strict Content-Security-Policy (see `netlify.toml`); the
  only external origins are GitHub's release-asset hosts, which serve the
  audio, slides, and ebook downloads.
- All listener state lives in `localStorage` on the visitor's device; there is
  no server-side state to compromise.
- The sync workflow (`.github/workflows/sync-catalog.yml`) runs with the
  default `GITHUB_TOKEN` scoped to this repository only.
