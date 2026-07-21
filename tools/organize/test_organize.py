#!/usr/bin/env python3
"""Unit tests for organize.build_plan — the meticulous matcher. Pure, no network,
no disk: the catalog and the release state are injected. Run: python3 test_organize.py"""

import struct
import unittest
import organize as O


def wav_bytes(seconds, rate=8000):
    data = b'\x00\x00' * (seconds * rate)
    hdr = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVE'
    hdr += b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16)
    hdr += b'data' + struct.pack('<I', len(data))
    return hdr + data


def mp3_cbr(frames=100):
    ln = (1152 // 8 * 128000) // 44100  # 417, MPEG1 L3 44.1k 128k
    f = bytearray(ln)
    f[0], f[1], f[2], f[3] = 0xff, 0xfb, 0x90, 0x00
    return bytes(f) * frames


M4A_HEAD = b'\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A mp42'

CATALOG = {
    'mediaRepo': 'kmay89/audio_book',
    'books': [{
        'slug': 'grows', 'releaseTag': 'media-grows',
        'chapters': [
            {'n': 1, 'slug': 'ch-origins', 'title': 'The First Mark'},
            {'n': 5, 'slug': 'ch-number', 'title': 'The Widening of Number'},
            {'n': 16, 'slug': 'ch-machine', 'title': 'The Thinking Machine'},
        ],
    }],
}


def staged(*triples):
    return [{'name': n, 'sha256': s, 'size': sz} for (n, s, sz) in triples]


def by_name(plan):
    return {e['name']: e for e in plan['items']}


class MatchTests(unittest.TestCase):
    def plan(self, files, release=None, mapping=None):
        return O.build_plan('grows', CATALOG, files, release or {}, mapping)

    def test_new_audio_by_number(self):
        p = self.plan(staged(('5.m4a', 'aaa', 10)))
        e = by_name(p)['5.m4a']
        self.assertEqual(e['status'], O.NEW)
        self.assertEqual(e['target'], 'grows__ch-number.m4a')

    def test_pdf_and_images_targets(self):
        p = self.plan(staged(('5.pdf', 'p', 1), ('5 first.png', 'i1', 1), ('5 second.png', 'i2', 1)))
        t = by_name(p)
        self.assertEqual(t['5.pdf']['target'], 'grows__ch-number__slides.pdf')
        self.assertEqual(t['5 first.png']['target'], 'grows__ch-number__slide-01.png')
        self.assertEqual(t['5 second.png']['target'], 'grows__ch-number__slide-02.png')

    def test_duplicate_detected_by_hash(self):
        release = {'grows__ch-number.m4a': {'sha256': 'same', 'size': 10}}
        p = self.plan(staged(('5.m4a', 'same', 10)), release)
        self.assertEqual(by_name(p)['5.m4a']['status'], O.DUPLICATE)

    def test_replace_when_slot_filled_with_different_content(self):
        release = {'grows__ch-number.m4a': {'sha256': 'old', 'size': 10}}
        p = self.plan(staged(('5.m4a', 'new', 12)), release)
        e = by_name(p)['5.m4a']
        self.assertEqual(e['status'], O.REPLACE)
        self.assertIn('grows__ch-number.m4a', e['deletes'])

    def test_replace_audio_lists_derived_mp3_to_delete(self):
        # chapter filled via the transcoded mp3; a new .m4a must clear it so
        # the CI transcode regenerates (else the mp3 goes stale)
        release = {'grows__ch-machine.mp3': {'sha256': 'x', 'size': 9}}
        p = self.plan(staged(('16.m4a', 'y', 9)), release)
        e = by_name(p)['16.m4a']
        self.assertEqual(e['status'], O.REPLACE)
        self.assertEqual(e['deletes'], ['grows__ch-machine.mp3'])

    def test_replace_slides_clears_whole_group(self):
        release = {
            'grows__ch-machine__slides.pdf': {'sha256': 'a', 'size': 1},
            'grows__ch-machine__slide-01.jpg': {'sha256': 'b', 'size': 1},
            'grows__ch-machine__slide-02.jpg': {'sha256': 'c', 'size': 1},
        }
        p = self.plan(staged(('16.pdf', 'new', 2)), release)
        e = by_name(p)['16.pdf']
        self.assertEqual(e['status'], O.REPLACE)
        self.assertEqual(set(e['deletes']),
                         {'grows__ch-machine__slides.pdf',
                          'grows__ch-machine__slide-01.jpg', 'grows__ch-machine__slide-02.jpg'})

    def test_out_of_range_number_is_unmatched(self):
        p = self.plan(staged(('9.m4a', 'z', 1)))  # no chapter 9
        e = by_name(p)['9.m4a']
        self.assertEqual(e['status'], O.UNMATCHED)
        self.assertIsNone(e['target'])

    def test_unknown_signal_is_unmatched_never_guessed(self):
        p = self.plan(staged(('cathedral final mix.m4a', 'z', 1)))
        self.assertEqual(by_name(p)['cathedral final mix.m4a']['status'], O.UNMATCHED)

    def test_map_csv_resolves_arbitrary_names(self):
        p = self.plan(staged(('final-mix.m4a', 'z', 1)), mapping={'final-mix.m4a': '16'})
        e = by_name(p)['final-mix.m4a']
        self.assertEqual(e['status'], O.NEW)
        self.assertEqual(e['target'], 'grows__ch-machine.m4a')

    def test_map_csv_accepts_slug(self):
        p = self.plan(staged(('mix.m4a', 'z', 1)), mapping={'mix.m4a': 'ch-origins'})
        self.assertEqual(by_name(p)['mix.m4a']['target'], 'grows__ch-origins.m4a')

    def test_already_conventional_name_passes_through_idempotently(self):
        p = self.plan(staged(('grows__ch-origins.m4a', 'h', 1)))
        e = by_name(p)['grows__ch-origins.m4a']
        self.assertEqual(e['status'], O.NEW)
        self.assertEqual(e['target'], 'grows__ch-origins.m4a')

    def test_conventional_slide_keeps_explicit_index(self):
        p = self.plan(staged(('grows__ch-origins__slide-07.jpg', 'h', 1)))
        self.assertEqual(by_name(p)['grows__ch-origins__slide-07.jpg']['target'],
                         'grows__ch-origins__slide-07.jpg')

    def test_in_batch_conflict_two_files_one_target(self):
        p = self.plan(staged(('5.m4a', 'a', 1), ('05 alt.m4a', 'b', 1)))
        statuses = {e['name']: e['status'] for e in p['items']}
        self.assertIn(O.CONFLICT, statuses.values())

    def test_chapter_status_reports_fill_state(self):
        release = {'grows__ch-machine.mp3': {'sha256': 'x', 'size': 1}}
        p = self.plan(staged(('1.m4a', 'a', 1)), release)
        rows = {r['n']: r for r in p['chapter_status']}
        self.assertTrue(rows[16]['audio'])
        self.assertFalse(rows[1]['audio'])


class DurationTests(unittest.TestCase):
    def test_wav_duration(self):
        self.assertAlmostEqual(O.audio_duration(wav_bytes(3)), 3.0, places=2)

    def test_mp3_cbr_duration(self):
        self.assertAlmostEqual(O.audio_duration(mp3_cbr(100)), 100 * 1152 / 44100, places=2)

    def test_garbage_has_no_duration(self):
        self.assertIsNone(O.audio_duration(b'not audio at all' * 10))


class InspectTests(unittest.TestCase):
    def probs(self, name, data):
        return O.inspect(name, data)['problems']

    def test_empty_file_is_error(self):
        self.assertTrue(any(p[0] == 'ERROR' for p in self.probs('7.m4a', b'')))

    def test_wrong_type_is_error(self):
        # a PDF saved with an audio extension
        p = self.probs('7.m4a', b'%PDF-1.5\n...')
        self.assertTrue(any(p_[0] == 'ERROR' and 'pdf' in p_[1] for p_ in p))

    def test_mislabeled_audio_extension_is_error(self):
        p = self.probs('7.mp3', M4A_HEAD + b'\x00' * 40)
        self.assertTrue(any(p_[0] == 'ERROR' for p_ in p))

    def test_valid_wav_reports_duration_no_error(self):
        info = O.inspect('5.wav', wav_bytes(45))
        self.assertIsNone(next((p for p in info['problems'] if p[0] == 'ERROR'), None))
        self.assertAlmostEqual(info['duration'], 45.0, places=1)

    def test_short_audio_warns(self):
        p = self.probs('5.wav', wav_bytes(3))
        self.assertTrue(any(p_[0] == 'WARN' and 'whole chapter' in p_[1] for p_ in p))

    def test_truncated_pdf_warns_no_eof(self):
        p = self.probs('5.pdf', b'%PDF-1.4\n/Type /Page \n(no trailer here)')
        self.assertTrue(any('end marker' in p_[1] for p_ in p))

    def test_valid_pdf_counts_pages(self):
        data = b'%PDF-1.4\n/Type /Page \n/Type /Page \n%%EOF'
        info = O.inspect('5.pdf', data)
        self.assertEqual(info['pages'], 2)
        self.assertFalse(any(p[0] == 'ERROR' for p in info['problems']))


CATALOG_DUR = {
    'mediaRepo': 'kmay89/audio_book',
    'books': [{
        'slug': 'grows', 'releaseTag': 'media-grows',
        'chapters': [
            {'n': 1, 'slug': 'ch-origins', 'title': 'A'},
            {'n': 16, 'slug': 'ch-machine', 'title': 'The Thinking Machine',
             'audio': {'file': 'grows__ch-machine.mp3', 'duration': 3000}},
        ],
    }],
}


class PlanIntegrityTests(unittest.TestCase):
    def test_error_probe_holds_item_back(self):
        s = [{'name': '1.m4a', 'sha256': 'a', 'size': 5,
              'probe': {'problems': [['ERROR', 'bad header']]}}]
        p = O.build_plan('grows', CATALOG, s, {})
        self.assertEqual(by_name(p)['1.m4a']['integrity'], 'ERROR')

    def test_replace_flags_big_length_change(self):
        release = {'grows__ch-machine.mp3': {'sha256': 'old', 'size': 9}}
        s = [{'name': '16.m4a', 'sha256': 'new', 'size': 9,
              'probe': {'duration': 120, 'problems': []}}]
        p = O.build_plan('grows', CATALOG_DUR, s, release)
        e = by_name(p)['16.m4a']
        self.assertEqual(e['status'], O.REPLACE)
        self.assertTrue(any('length change' in m for _, m in e['problems']))

    def test_identical_bytes_in_batch_warn(self):
        s = [{'name': '1.m4a', 'sha256': 'dup', 'size': 5, 'probe': {'problems': []}},
             {'name': '16.m4a', 'sha256': 'dup', 'size': 5, 'probe': {'problems': []}}]
        p = O.build_plan('grows', CATALOG, s, {})
        e = by_name(p)['1.m4a']
        self.assertTrue(any('identical bytes' in m for _, m in e['problems']))

    def test_clean_file_is_ok(self):
        s = [{'name': '1.m4a', 'sha256': 'a', 'size': 5, 'probe': {'duration': 2000, 'problems': []}}]
        p = O.build_plan('grows', CATALOG, s, {})
        self.assertEqual(by_name(p)['1.m4a']['integrity'], 'OK')


class PublishCommandTests(unittest.TestCase):
    def test_order_is_delete_then_upload_then_dispatch(self):
        cmds = O.publish_commands('media-grows', 'kmay89/audio_book',
                                  ['grows__ch-a.m4a'], ['grows__ch-a.mp3'])
        self.assertEqual(cmds[0][:3], ['gh', 'release', 'delete-asset'])
        self.assertEqual(cmds[1][:3], ['gh', 'release', 'upload'])
        self.assertEqual(cmds[-1], ['gh', 'workflow', 'run', 'sync-catalog.yml', '--repo', 'kmay89/audio_book'])

    def test_no_upload_command_when_nothing_new(self):
        cmds = O.publish_commands('media-grows', 'kmay89/audio_book', [], [])
        self.assertTrue(all(c[:3] != ['gh', 'release', 'upload'] for c in cmds))
        self.assertEqual(cmds[-1][:3], ['gh', 'workflow', 'run'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
