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
import shutil
import subprocess
import sys
import time
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
    book_obj, by_n, slug_set = chapter_index(catalog, book_slug)
    published = {c['slug']: (c.get('audio') or {}).get('duration') for c in book_obj['chapters']}
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

    attach_integrity(items, staged, release_state, published)
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


# ---------------------------------------------------------------- integrity
# Look *inside* each file so a wrong / corrupt / half-downloaded file is caught
# before it is ever renamed or uploaded. All pure (operate on bytes) → testable.

EXT_KIND = {'.mp3': 'mp3', '.m4a': 'm4a', '.wav': 'wav', '.aac': 'aac', '.ogg': 'ogg',
            '.opus': 'ogg', '.pdf': 'pdf', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg',
            '.webp': 'webp'}
CATEGORY = {'mp3': 'audio', 'm4a': 'audio', 'wav': 'audio', 'aac': 'audio', 'ogg': 'audio',
            'pdf': 'pdf', 'png': 'image', 'jpg': 'image', 'webp': 'image'}


def fmt_dur(s):
    s = int(round(s))
    return f'{s // 60}:{s % 60:02d}'


def sniff(data):
    """The file type the *bytes* actually are (magic number), or None."""
    if len(data) >= 12 and data[0:4] == b'RIFF' and data[8:12] == b'WAVE':
        return 'wav'
    if len(data) >= 12 and data[0:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    if len(data) >= 12 and data[4:8] == b'ftyp':
        return 'm4a'
    if data[0:3] == b'ID3' or (len(data) > 1 and data[0] == 0xff and (data[1] & 0xe0) == 0xe0):
        return 'mp3'
    if data[0:4] == b'OggS':
        return 'ogg'
    if data[0:5] == b'%PDF-':
        return 'pdf'
    if data[0:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if data[0:3] == b'\xff\xd8\xff':
        return 'jpg'
    return None


def inspect(name, data, size=None, full=True):
    """Return {size, magic, duration, pages, problems:[[level,msg]]}. `level` is
    ERROR (block) or WARN (advise). `full=False` = header-only (huge file)."""
    if size is None:
        size = len(data)
    ext = ext_of(name)
    cat = CATEGORY.get(EXT_KIND.get(ext))
    probs = []
    out = {'size': size, 'magic': None, 'duration': None, 'pages': None, 'problems': probs}
    if size == 0:
        probs.append(['ERROR', 'empty file (0 bytes) — a failed copy or download'])
        return out
    s = sniff(data)
    out['magic'] = s
    if cat is None:
        return out  # unknown extension; the matcher reports it as UNMATCHED
    if s is None:
        if ext in ('.aac', '.opus'):
            probs.append(['WARN', 'could not verify the audio header for this format'])
        else:
            probs.append(['ERROR', f'does not look like a real {ext} file (bad or missing header)'])
    else:
        if CATEGORY.get(s) != cat:
            probs.append(['ERROR', f'looks like a {s} file, not {ext} — wrong file?'])
        elif cat == 'audio' and s != EXT_KIND.get(ext):
            probs.append(['ERROR', f'bytes are {s} but the name says {ext} — rename to .{s}'])
    has_err = any(p[0] == 'ERROR' for p in probs)
    if cat == 'audio' and not has_err:
        if not full:
            probs.append(['WARN', 'file too large to fully verify its length here'])
        else:
            try:
                d = audio_duration(data, name)
            except Exception:
                d = None
            if d is None:
                probs.append(['ERROR', 'audio would not decode — truncated or not really audio'])
            else:
                out['duration'] = d
                if d < 20:
                    probs.append(['WARN', f'only {fmt_dur(d)} long — is this the whole chapter?'])
    if cat == 'pdf' and s == 'pdf' and full:
        if b'%%EOF' not in data[-4096:]:
            probs.append(['WARN', 'PDF has no end marker — it may be truncated'])
        pages = len(re.findall(rb'/Type\s*/Page[^s]', data))
        out['pages'] = pages or None
        if pages == 0:
            probs.append(['WARN', 'no pages detected in the PDF — is it a real deck?'])
    return out


def audio_duration(data, name=''):
    """Seconds, or None. Ported from tools/duration.mjs (MP3/M4A/WAV)."""
    n = len(data)
    if n >= 12 and data[0:4] == b'RIFF' and data[8:12] == b'WAVE':
        return _wav_duration(data)
    if n >= 12 and data[4:8] == b'ftyp':
        return _mp4_duration(data)
    return _mp3_duration(data)


def _wav_duration(b):
    off, byte_rate, data_len, n = 12, 0, 0, len(b)
    while off + 8 <= n:
        cid = b[off:off + 4]
        size = int.from_bytes(b[off + 4:off + 8], 'little')
        if cid == b'fmt ' and off + 20 <= n:
            byte_rate = int.from_bytes(b[off + 16:off + 20], 'little')
        if cid == b'data':
            data_len = size
        off += 8 + size + (size % 2)
    return data_len / byte_rate if byte_rate and data_len else None


def _mp4_duration(b):
    n = len(b)

    def find(start, end, typ):
        off = start
        while off + 8 <= end:
            size = int.from_bytes(b[off:off + 4], 'big')
            t = b[off + 4:off + 8]
            head = 8
            if size == 1:
                if off + 16 > end:
                    break
                size = int.from_bytes(b[off + 8:off + 16], 'big')
                head = 16
            elif size == 0:
                size = end - off
            if size < head:
                break
            if t == typ:
                return (off + head, off + size)
            off += size
        return None

    moov = find(0, n, b'moov')
    if not moov:
        return None
    mvhd = find(moov[0], moov[1], b'mvhd')
    if not mvhd:
        return None
    o = mvhd[0]
    if b[o] == 1:
        ts = int.from_bytes(b[o + 20:o + 24], 'big')
        dur = int.from_bytes(b[o + 24:o + 32], 'big')
    else:
        ts = int.from_bytes(b[o + 12:o + 16], 'big')
        dur = int.from_bytes(b[o + 16:o + 20], 'big')
    return dur / ts if ts else None


_BITRATES = {'v1l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
             'v2l3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
_SRATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def _is_frame(b, off):
    return off + 2 < len(b) and b[off] == 0xff and (b[off + 1] & 0xe0) == 0xe0 \
        and (b[off + 1] & 0x18) != 0x08 and (b[off + 1] & 0x06) != 0x00 \
        and (b[off + 2] & 0xf0) != 0xf0 and (b[off + 2] & 0x0c) != 0x0c


def _parse_frame(b, off):
    if off + 3 >= len(b):
        return None
    b1, b2, b3 = b[off + 1], b[off + 2], b[off + 3]
    version, layer = (b1 >> 3) & 3, (b1 >> 1) & 3
    if layer != 1:
        return None
    mpeg1 = version == 3
    bidx, sidx, pad, ch = (b2 >> 4) & 0xf, (b2 >> 2) & 3, (b2 >> 1) & 1, (b3 >> 6) & 3
    sr = _SRATES.get(version, [0, 0, 0])[sidx] if sidx < 3 else 0
    br = (_BITRATES['v1l3'] if mpeg1 else _BITRATES['v2l3'])[bidx] * 1000
    if not sr or not br:
        return None
    spf = 1152 if mpeg1 else 576
    mono = ch == 3
    side = (17 if mono else 32) if mpeg1 else (9 if mono else 17)
    return {'sr': sr, 'spf': spf, 'length': (spf // 8 * br) // sr + pad, 'side': side}


def _mp3_duration(b):
    n, off = len(b), 0
    if n > 10 and b[0:3] == b'ID3':
        off = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f))
    while off + 4 < n and not _is_frame(b, off):
        off += 1
    if off + 4 >= n:
        return None
    first = _parse_frame(b, off)
    if not first:
        return None
    xoff = off + 4 + first['side']
    if xoff + 16 <= n and b[xoff:xoff + 4] in (b'Xing', b'Info'):
        if int.from_bytes(b[xoff + 4:xoff + 8], 'big') & 1:
            frames = int.from_bytes(b[xoff + 8:xoff + 12], 'big')
            return frames * first['spf'] / first['sr']
    voff = off + 4 + 32
    if voff + 26 <= n and b[voff:voff + 4] == b'VBRI':
        frames = int.from_bytes(b[voff + 14:voff + 18], 'big')
        return frames * first['spf'] / first['sr']
    seconds, pos, bad = 0.0, off, 0
    while pos + 4 < n:
        f = _parse_frame(b, pos) if _is_frame(b, pos) else None
        if f and f['length'] > 0:
            seconds += f['spf'] / f['sr']
            pos += f['length']
            bad = 0
        else:
            pos += 1
            bad += 1
            if bad > 2048:
                break
    return seconds if seconds > 0 else None


def attach_integrity(items, staged, release_state, published):
    """Merge probe findings + cross-file checks onto each plan item. Sets
    item['problems'] (list of [level,msg]) and item['integrity'] (OK/WARN/ERROR)."""
    probe_by = {s['name']: (s.get('probe') or {}) for s in staged}
    local_by_hash, release_by_hash = {}, {}
    for s in staged:
        if s.get('sha256'):
            local_by_hash.setdefault(s['sha256'], []).append(s['name'])
    for nm, meta in release_state.items():
        if meta.get('sha256'):
            release_by_hash.setdefault(meta['sha256'], []).append(nm)

    for e in items:
        pb = probe_by.get(e['name'], {})
        probs = list(e.get('problems') or []) + [list(p) for p in pb.get('problems', [])]
        e['duration'], e['pages'] = pb.get('duration'), pb.get('pages')
        if e.get('status') == REPLACE and e.get('kind') == 'audio' and pb.get('duration'):
            pub = published.get(e.get('slug'))
            if pub and abs(pb['duration'] - pub) > max(3, 0.03 * pub):
                probs.append(['WARN', f"published is {fmt_dur(pub)}, this is {fmt_dur(pb['duration'])}"
                                      " — big length change, confirm it's the right file"])
        if e.get('sha256'):
            twins = [nm for nm in local_by_hash.get(e['sha256'], []) if nm != e['name']]
            if twins:
                probs.append(['WARN', 'identical bytes to ' + ', '.join(sorted(twins)) + ' in this batch'])
            if e.get('status') != DUPLICATE:
                ups = [nm for nm in release_by_hash.get(e['sha256'], []) if nm != e.get('target')]
                if ups:
                    probs.append(['WARN', 'identical bytes already uploaded as ' + ', '.join(sorted(ups))])
        e['problems'] = probs
        e['integrity'] = 'ERROR' if any(p[0] == 'ERROR' for p in probs) else ('WARN' if probs else 'OK')


# ---------------------------------------------------------------- I/O shell

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def probe_path(path):
    """(sha256, probe) reading the file once; header-only for very large files."""
    size = path.stat().st_size
    cap = 512 * 1024 * 1024
    if size > cap:
        h, head = hashlib.sha256(), bytearray()
        with open(path, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                h.update(chunk)
                if len(head) < 65536:
                    head += chunk[:65536 - len(head)]
        return h.hexdigest(), inspect(path.name, bytes(head), size=size, full=False)
    data = path.read_bytes()
    return hashlib.sha256(data).hexdigest(), inspect(path.name, data, size=size, full=True)


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
    ap.add_argument('--publish', action='store_true', help='after --apply, upload via gh + dispatch the sync + watch it')
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
    staged = []
    for p in files:
        sha, probe = probe_path(p)
        staged.append({'name': p.name, 'sha256': sha, 'size': p.stat().st_size, 'probe': probe})
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
        meta = []
        if e.get('duration'):
            meta.append(fmt_dur(e['duration']))
        if e.get('pages'):
            meta.append(f"{e['pages']}p")
        if e.get('slug'):
            title = next((c['title'] for c in chapters if c['slug'] == e['slug']), '')
            if title:
                meta.append(title)
        tag = '  [' + ' · '.join(meta) + ']' if meta else ''
        bad = e.get('integrity') == 'ERROR'
        print(f"  {'✗' if bad else ICON.get(e['status'],' ')} {e['status']:9} {e['name']}  →  {tgt}{tag}")
        if e.get('note'):
            print(f"      {e['note']}")
        for lvl, msg in e.get('problems', []):
            print(f"      {'ERROR' if lvl == 'ERROR' else 'warn '}: {msg}")
        for d in e.get('deletes', []):
            print(f"      delete first: {d}")

    errored = [e for e in items if e.get('integrity') == 'ERROR']
    approved = [e for e in items
                if e.get('integrity') != 'ERROR'
                and (e['status'] == NEW or (e['status'] == REPLACE and args.replace))]
    blocked = [e for e in items if e['status'] == REPLACE and not args.replace and e.get('integrity') != 'ERROR']
    conflicts = [e for e in items if e['status'] == CONFLICT]

    print()
    if errored:
        print(f"  ✗ {len(errored)} file(s) failed an integrity check — held back, never renamed or uploaded. Fix and re-run.")
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

    if args.apply and getattr(args, 'publish', False) and approved and not conflicts:
        print('\n  Publishing…')
        run_publish(approved, book, inbox)
        print()
        return

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
        if args.apply:
            print('  (or re-run with --publish to do this automatically)')
    print()


def plan_repo():
    return json.loads((ROOT / 'catalog.json').read_text())['mediaRepo']


def publish_commands(tag, repo, targets, deletes):
    """The exact gh commands to publish an approved plan: clear stale assets
    first, upload the new ones, then dispatch the sync. Pure → testable."""
    cmds = [['gh', 'release', 'delete-asset', tag, d, '--yes', '--repo', repo] for d in sorted(deletes)]
    if targets:
        cmds.append(['gh', 'release', 'upload', tag, *sorted(targets), '--repo', repo, '--clobber'])
    cmds.append(['gh', 'workflow', 'run', 'sync-catalog.yml', '--repo', repo])
    return cmds


def run_publish(approved, book, inbox):
    """Upload + dispatch the sync via gh, then watch the run and report."""
    if not shutil.which('gh'):
        print("  gh isn't installed — run the commands above by hand, or `brew install gh`.")
        return
    tag, repo = book['releaseTag'], plan_repo()
    targets = [e['target'] for e in approved]
    deletes = sorted({d for e in approved for d in e.get('deletes', [])})
    for cmd in publish_commands(tag, repo, targets, deletes):
        print('  $ ' + ' '.join(cmd))
        if subprocess.run(cmd, cwd=str(inbox)).returncode != 0:
            print('  ✗ that command failed — stopping so nothing is left half-done.')
            return
    print('  ✓ uploaded and sync dispatched — watching it publish…')
    try:
        time.sleep(5)  # let the dispatched run register
        rid = subprocess.run(['gh', 'run', 'list', '--workflow', 'sync-catalog.yml', '--repo', repo,
                              '-L', '1', '--json', 'databaseId', '-q', '.[0].databaseId'],
                             capture_output=True, text=True).stdout.strip()
        if rid:
            subprocess.run(['gh', 'run', 'watch', rid, '--repo', repo, '--exit-status'])
            print('  ✓ done. Give the site ~2 min to redeploy, then check the chapter.')
    except Exception as e:
        print(f'  (could not watch the run: {e} — check the Actions tab)')


if __name__ == '__main__':
    main()
