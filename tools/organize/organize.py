#!/usr/bin/env python3
"""
organize.py — the meticulous staging desk for hear-my-book media.

Dump a book's raw files into  tools/organize/inbox/<book>/  and run:

    python3 tools/organize/organize.py <book>            # plan only (safe, default)
    python3 tools/organize/organize.py <book> --apply    # do the renames
    python3 tools/organize/organize.py <book> --apply --replace   # also overwrite filled chapters

It reads THREE sources of truth and reconciles them so a rename is never wrong:

  1. catalog.json      — the chapters that exist (number, slug, title) and what
                         the player currently shows (audio / slides filled or pending).
  2. the media release — the assets actually uploaded, with their SHA-256 digests
                         (GitHub returns these), i.e. the real "already filled" state
                         and the oracle that makes duplicate detection exact.
  3. your inbox files  — hashed locally and matched to a chapter.

Every staged file gets one status, and the tool refuses to guess:

  NEW        chapter's slot is empty on the release        → will upload
  DUPLICATE  byte-identical file already uploaded           → skip (never re-uploaded)
  REPLACE    slot is filled with *different* content        → only with --replace,
                                                              and it lists the exact old
                                                              assets to delete first so
                                                              nothing goes stale
  UNMATCHED  no unambiguous chapter signal                  → left untouched, reported
  CONFLICT   two files want the same target                 → left untouched, reported

Matching a file to a chapter is deterministic (that is where the "100%" comes from):
  * a leading chapter number:  7.m4a, "07 deck.pdf", "7 infographic.png"
  * a file already named the convention: grows__ch-chance.m4a  (re-runs are safe)
  * an explicit  map.csv  in the inbox:  <filename>,<chapter number or slug>
Anything without one of those is UNMATCHED — it is never guessed from fuzzy text.

Needs only the Python standard library. GITHUB_TOKEN is optional (higher API rate
limits / private repos); the repo is public so anonymous reads work.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUDIO_EXT = ('.mp3', '.m4a', '.wav', '.aac', '.ogg', '.opus')
IMG_EXT = ('.png', '.jpg', '.jpeg', '.webp')

NEW, DUPLICATE, REPLACE, UNMATCHED, CONFLICT = 'NEW', 'DUPLICATE', 'REPLACE', 'UNMATCHED', 'CONFLICT'


# ---------------------------------------------------------------- pure helpers

def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]


def ext_of(name):
    return os.path.splitext(name)[1].lower()


def kind_of(name):
    """The media kind a raw filename represents, from its extension / hints."""
    ext = ext_of(name)
    stem = os.path.splitext(name)[0].lower()
    if ext in AUDIO_EXT:
        return 'audio'
    if ext == '.pdf':
        return 'slides_pdf'
    if ext in IMG_EXT:
        return 'slide_img'
    if ext in ('.txt', '.md'):
        if 'outline' in stem:
            return 'outline'
        if 'text' in stem:
            return 'text'
    return None


def parse_conventional(name, book, slug_set):
    """If `name` already follows <book>__<slug>[__extra].<ext>, return
    (slug, kind, explicit_slide_index|None); else None. Lets re-runs be idempotent
    and lets you dump already-correct files."""
    ext = ext_of(name)
    stem = name[: len(name) - len(ext)]
    parts = stem.split('__')
    if len(parts) < 2 or parts[0] != book or parts[1] not in slug_set:
        return None
    slug = parts[1]
    extra = '__'.join(parts[2:])
    if extra == '' and ext in AUDIO_EXT:
        return (slug, 'audio', None)
    if extra == 'slides' and ext == '.pdf':
        return (slug, 'slides_pdf', None)
    m = re.fullmatch(r'slide-(\d+)', extra)
    if m and ext in IMG_EXT:
        return (slug, 'slide_img', int(m.group(1)))
    if extra == 'outline' and ext in ('.txt', '.md'):
        return (slug, 'outline', None)
    if extra == 'text' and ext in ('.txt', '.md'):
        return (slug, 'text', None)
    return None


def leading_number(name):
    m = re.match(r'(\d{1,2})(?!\d)', name)
    return int(m.group(1)) if m else None


def target_name(book, slug, kind, ext, slide_index=None):
    if kind == 'audio':
        return f'{book}__{slug}{ext}'
    if kind == 'slides_pdf':
        return f'{book}__{slug}__slides.pdf'
    if kind == 'slide_img':
        return f'{book}__{slug}__slide-{slide_index:02d}{ext}'
    if kind == 'outline':
        return f'{book}__{slug}__outline{ext}'
    if kind == 'text':
        return f'{book}__{slug}__text{ext}'
    return None


def chapter_index(catalog, book_slug):
    """{n: {slug,title}} and the set of slugs for a book."""
    book = next((b for b in catalog['books'] if b['slug'] == book_slug), None)
    if not book:
        raise SystemExit(f"no book '{book_slug}' in catalog.json")
    by_n = {c['n']: {'slug': c['slug'], 'title': c['title']} for c in book['chapters']}
    slugs = {c['slug'] for c in book['chapters']}
    return book, by_n, slugs


def existing_media(book, slug, release_names):
    """Assets already on the release for this chapter, grouped by kind."""
    audio = [n for n in release_names
             if n in (f'{book}__{slug}{e}' for e in AUDIO_EXT)]
    pdf = [f'{book}__{slug}__slides.pdf'] if f'{book}__{slug}__slides.pdf' in release_names else []
    imgs = sorted([n for n in release_names
                   if re.fullmatch(rf'{re.escape(book)}__{re.escape(slug)}__slide-\d+\.\w+', n)],
                  key=natural_key)
    return {'audio': audio, 'pdf': pdf, 'imgs': imgs}


# ---------------------------------------------------------------- the plan

def build_plan(book_slug, catalog, staged, release_state, mapping=None):
    """Pure core. `staged` = [{name, sha256, size}]; `release_state` =
    {asset_name: {sha256, size}}; `mapping` = {filename: chapter n or slug}.
    Returns dict(items, chapter_status, targets) — no I/O, fully testable."""
    _book, by_n, slug_set = chapter_index(catalog, book_slug)
    mapping = mapping or {}
    slug_to_n = {v['slug']: n for n, v in by_n.items()}
    release_names = set(release_state)

    items = []
    # first pass: resolve each file to (slug, kind); collect raw slide imgs to sequence
    resolved = []
    raw_imgs = {}  # slug -> list of staged entries, to number in order
    for f in sorted(staged, key=lambda e: natural_key(e['name'])):
        name = f['name']
        note = ''
        conv = parse_conventional(name, book_slug, slug_set)
        if conv:
            slug, kind, idx = conv
        else:
            kind = kind_of(name)
            # chapter number: explicit map wins, else leading number
            n = None
            if name in mapping:
                mv = mapping[name]
                n = slug_to_n.get(mv) if isinstance(mv, str) and not mv.isdigit() else int(mv)
            else:
                n = leading_number(name)
            slug = by_n.get(n, {}).get('slug') if n is not None else None
            idx = None
            if kind is None:
                resolved.append({**f, 'status': UNMATCHED, 'note': 'unknown file type', 'kind': None,
                                 'slug': None, 'target': None})
                continue
            if slug is None:
                why = 'no chapter number / mapping' if n is None else f'chapter {n} is out of range'
                resolved.append({**f, 'status': UNMATCHED, 'note': why, 'kind': kind,
                                 'slug': None, 'target': None})
                continue
        if not conv and kind == 'slide_img':
            raw_imgs.setdefault(slug, []).append(f)
            resolved.append({**f, 'kind': kind, 'slug': slug, 'idx': None, 'deferred': True})
            continue
        resolved.append({**f, 'kind': kind, 'slug': slug, 'idx': idx, 'deferred': False, 'note': note})

    # assign sequential slide numbers to raw images per chapter (natural order,
    # keyed by filename — names are unique within an inbox)
    for slug, group in raw_imgs.items():
        order = sorted((e['name'] for e in group), key=natural_key)
        seq = {name: i + 1 for i, name in enumerate(order)}
        for e in resolved:
            if e.get('deferred') and e.get('slug') == slug:
                e['idx'] = seq.get(e['name'])

    # second pass: assign targets, detect duplicates/replaces/conflicts
    seen_targets = {}
    for e in resolved:
        if e.get('status') == UNMATCHED:
            items.append(e)
            continue
        ext = ext_of(e['name'])
        tgt = target_name(book_slug, e['slug'], e['kind'], ext, e.get('idx'))
        e['target'] = tgt
        existing = existing_media(book_slug, e['slug'], release_names)
        deletes = []
        if tgt in release_state and release_state[tgt].get('sha256') and e.get('sha256') \
                and release_state[tgt]['sha256'] == e['sha256']:
            status, note = DUPLICATE, 'byte-identical file already uploaded'
        else:
            filled = _chapter_slot_filled(e['kind'], existing)
            if filled:
                status = REPLACE
                deletes = _delete_set(book_slug, e['slug'], e['kind'], existing)
                note = 'chapter slot filled with different content — delete-first list below'
            else:
                status, note = NEW, ''
        e['status'], e['note'], e['deletes'] = status, note, deletes
        # in-batch collision: two files → same target
        if tgt in seen_targets and seen_targets[tgt] != e['name']:
            e['status'] = CONFLICT
            e['note'] = f"also produced by {seen_targets[tgt]}"
        else:
            seen_targets[tgt] = e['name']
        items.append(e)

    chapter_status = _chapter_status(book_slug, by_n, release_names)
    return {'items': items, 'chapter_status': chapter_status}


def _chapter_slot_filled(kind, existing):
    if kind == 'audio':
        return bool(existing['audio'])
    if kind in ('slides_pdf', 'slide_img'):
        return bool(existing['pdf'] or existing['imgs'])
    return False  # outline/text overwrite freely; sync tags provenance


def _delete_set(book, slug, kind, existing):
    if kind == 'audio':
        return list(existing['audio'])
    if kind in ('slides_pdf', 'slide_img'):
        # clear the whole slide group so page counts can shrink and the
        # CI rasterizer re-runs (it skips a deck that already has images)
        return list(existing['pdf']) + list(existing['imgs'])
    return []


def _chapter_status(book, by_n, release_names):
    rows = []
    for n in sorted(by_n):
        slug = by_n[n]['slug']
        ex = existing_media(book, slug, release_names)
        rows.append({
            'n': n, 'slug': slug, 'title': by_n[n]['title'],
            'audio': bool(ex['audio']),
            'slides': ('pdf+%d imgs' % len(ex['imgs'])) if ex['imgs'] else ('pdf' if ex['pdf'] else ''),
        })
    return rows


# ---------------------------------------------------------------- I/O shell

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch_release_state(media_repo, tag):
    """{asset_name: {sha256, size}} from the GitHub release, or {} if none yet."""
    url = f'https://api.github.com/repos/{media_repo}/releases/tags/{tag}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'audio-book-organize', 'Accept': 'application/vnd.github+json'})
    tok = os.environ.get('GITHUB_TOKEN')
    if tok:
        req.add_header('Authorization', f'Bearer {tok}')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise
    out = {}
    for a in data.get('assets', []):
        dig = (a.get('digest') or '')
        sha = dig.split('sha256:')[-1] if dig.startswith('sha256:') else None
        out[a['name']] = {'sha256': sha, 'size': a.get('size')}
    return out


def read_mapping(inbox):
    """Optional map.csv: rows of <filename>,<chapter number or slug>."""
    p = inbox / 'map.csv'
    if not p.exists():
        return {}
    mapping = {}
    with open(p, newline='') as fh:
        for row in csv.reader(fh):
            if len(row) >= 2 and row[0].strip() and not row[0].strip().startswith('#'):
                mapping[row[0].strip()] = row[1].strip()
    return mapping


ICON = {NEW: '＋', DUPLICATE: '=', REPLACE: '‼', UNMATCHED: '?', CONFLICT: '✗'}


def main():
    ap = argparse.ArgumentParser(description='Organize a book\'s media inbox into the release naming convention.')
    ap.add_argument('book', help='book slug from catalog.json (e.g. grows)')
    ap.add_argument('--apply', action='store_true', help='perform the renames (default: plan only)')
    ap.add_argument('--replace', action='store_true', help='also rename files whose chapter slot is already filled')
    ap.add_argument('--offline', action='store_true', help='skip the release lookup (no dup/replace detection)')
    ap.add_argument('--inbox', help='override the inbox folder (default tools/organize/inbox/<book>)')
    args = ap.parse_args()

    catalog = json.loads((ROOT / 'catalog.json').read_text())
    book = next((b for b in catalog['books'] if b['slug'] == args.book), None)
    if not book:
        raise SystemExit(f"no book '{args.book}' in catalog.json")

    inbox = Path(args.inbox) if args.inbox else (Path(__file__).resolve().parent / 'inbox' / args.book)
    inbox.mkdir(parents=True, exist_ok=True)
    files = [p for p in sorted(inbox.iterdir(), key=lambda p: natural_key(p.name))
             if p.is_file() and p.name != 'map.csv' and not p.name.startswith('.')]
    if not files:
        print(f'Inbox is empty: {inbox}\nDrop this book\'s files there (numbered 1.m4a, 2.pdf … or a map.csv) and re-run.')
        return

    release_state = {} if args.offline else fetch_release_state(catalog['mediaRepo'], book['releaseTag'])
    staged = [{'name': p.name, 'sha256': sha256_file(p), 'size': p.stat().st_size} for p in files]
    plan = build_plan(args.book, catalog, staged, release_state, read_mapping(inbox))

    _print_report(plan, book, args, inbox, offline=args.offline)


def _print_report(plan, book, args, inbox, offline):
    items, chapters = plan['items'], plan['chapter_status']
    print(f"\n  {book['slug']} — release {book['releaseTag']}"
          + ('   [offline: no duplicate/replace check]' if offline else '') + '\n')

    filled = sum(1 for c in chapters if c['audio'])
    print(f"  Book status: {filled}/{len(chapters)} chapters have audio"
          + (f", {sum(1 for c in chapters if c['slides'])} have slides" if chapters else '') + '\n')

    order = {NEW: 0, REPLACE: 1, DUPLICATE: 2, CONFLICT: 3, UNMATCHED: 4}
    for e in sorted(items, key=lambda x: (order.get(x['status'], 9), natural_key(x['name']))):
        tgt = e.get('target') or '—'
        ch = ''
        if e.get('slug'):
            title = next((c['title'] for c in chapters if c['slug'] == e['slug']), '')
            ch = f"  ({title})"
        print(f"  {ICON.get(e['status'],' ')} {e['status']:9} {e['name']}  →  {tgt}{ch}")
        if e.get('note'):
            print(f"      {e['note']}")
        for d in e.get('deletes', []):
            print(f"      delete first: {d}")

    approved = [e for e in items if e['status'] == NEW or (e['status'] == REPLACE and args.replace)]
    blocked = [e for e in items if e['status'] == REPLACE and not args.replace]
    conflicts = [e for e in items if e['status'] == CONFLICT]

    print()
    if conflicts:
        print(f"  ✗ {len(conflicts)} conflict(s) — resolve before applying; nothing was touched.")
    if blocked:
        print(f"  ‼ {len(blocked)} chapter(s) already filled — re-run with --replace to overwrite them.")

    if args.apply and not conflicts:
        did = 0
        for e in approved:
            src, dst = inbox / e['name'], inbox / e['target']
            if src.name == dst.name:
                continue
            if dst.exists():
                print(f"  skip {e['name']} — {e['target']} already in the inbox")
                continue
            src.rename(dst)
            did += 1
        print(f"  renamed {did} file(s) in {inbox}")
    elif approved:
        print(f"  Plan only. Re-run with --apply to rename {len(approved)} file(s).")

    dels = sorted({d for e in approved for d in e.get('deletes', [])})
    if dels:
        print('\n  Then delete the stale assets they replace:')
        for d in dels:
            print(f"    gh release delete-asset {book['releaseTag']} {d} --yes")
    if approved:
        names = ' '.join(sorted(e['target'] for e in approved))
        print('\n  Upload (from the inbox folder):')
        print(f"    cd {inbox} && gh release upload {book['releaseTag']} {names} "
              f"--repo {plan_repo()} --clobber")
        print(f"    gh workflow run sync-catalog.yml --repo {plan_repo()}")
    print()


def plan_repo():
    return json.loads((ROOT / 'catalog.json').read_text())['mediaRepo']


if __name__ == '__main__':
    main()
