#!/usr/bin/env python3
"""Unit tests for organize.build_plan — the meticulous matcher. Pure, no network,
no disk: the catalog and the release state are injected. Run: python3 test_organize.py"""

import unittest
import organize as O

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


if __name__ == '__main__':
    unittest.main(verbosity=2)
