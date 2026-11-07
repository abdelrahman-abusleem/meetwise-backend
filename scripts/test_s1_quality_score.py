"""Synthetic-only regressions; no provider, microphone, network or real content."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import s1_quality_score as scorer


def case(reference='one two', hypothesis='one two', group='EN', case_id='EN_1'):
    return dict(id=case_id, group=group, complete=True,
                reference=reference, hypothesis=hypothesis)


class QualityScoreTests(unittest.TestCase):
    def test_exact_and_normalization(self):
        result = scorer.score({'cases': [case('HELLO,  world!', 'hello world')]})
        self.assertEqual(result['overall']['WER']['ratio'], 0)
        self.assertEqual(result['overall']['CER']['ratio'], 0)
        self.assertEqual(result['status'], 'MEASUREMENT_ONLY_NOT_S1_ACCEPTANCE')

    def test_substitution(self):
        self.assertEqual(scorer.edits(['a', 'b'], ['a', 'c']),
                         dict(S=1, D=0, I=0, N=2, ratio=0.5))

    def test_deletion(self):
        self.assertEqual(scorer.edits(['a', 'b'], ['a'])['D'], 1)

    def test_insertions_can_exceed_one_hundred_percent(self):
        metric = scorer.edits(['a'], ['a', 'b', 'c'])
        self.assertEqual((metric['I'], metric['ratio']), (2, 2))

    def test_empty_hypothesis_is_all_deletions(self):
        self.assertEqual(scorer.edits(['a', 'b'], [])['D'], 2)

    def test_empty_reference_is_unscorable(self):
        with self.assertRaises(ValueError):
            scorer.score({'cases': [case('...', '')]})

    def test_unicode_nfc_and_scalar_count(self):
        result = scorer.score({'cases': [case('é😀', 'e\u0301😀')]})
        self.assertEqual(result['overall']['CER']['N'], 2)
        self.assertEqual(result['overall']['CER']['ratio'], 0)

    def test_arabic_variants_diacritics_and_tatweel_preserved(self):
        for first, second in [('أ', 'ا'), ('ى', 'ي'), ('بَ', 'ب'), ('بـ', 'ب')]:
            self.assertNotEqual(scorer.normalize(first), scorer.normalize(second))

    def test_explicit_whitespace_and_punctuation(self):
        self.assertEqual(scorer.normalize('أ،ب\u00a0C\tD'), 'أ ب c d')
        with self.assertRaises(ValueError):
            scorer.normalize('a\x1cb')

    def test_control_format_and_surrogate_rejection(self):
        for text in ['a\x00', 'a\u200f', 'a\ud800']:
            with self.assertRaises(ValueError):
                scorer.normalize(text)

    def test_deterministic_diagonal_tie(self):
        self.assertEqual(scorer.edits(['a', 'b'], ['b', 'a']),
                         dict(S=2, D=0, I=0, N=2, ratio=1))

    def test_weighted_groups_overall_and_macro(self):
        result = scorer.score({'cases': [
            case('a', 'z'), case('b c d', 'b c d', case_id='EN_2'),
            case('أ ب', 'أ ب', 'AR-EG', 'AR_1'),
        ]})
        self.assertEqual(result['groups']['EN']['WER']['ratio'], 0.25)
        self.assertEqual(result['overall']['WER']['ratio'], 1 / 6)
        self.assertEqual(result['macro']['WER'], 1 / 3)
        self.assertIsNone(result['groups']['MIX'])

    def test_partial_duplicate_and_invalid_case_rejected(self):
        for payload in [
            {'cases': [dict(case(), complete=False)]},
            {'cases': [case(), case()]},
            {'cases': [case(case_id='private text')]},
            {'cases': [case(group='UNKNOWN')]},
            {'cases': []}, {'cases': [case()] * 33},
            {'cases': [dict(case(), extra='no')]},
            [],
        ]:
            with self.assertRaises(ValueError):
                scorer.score(payload)

    def test_bounded_input_and_counts_only_output(self):
        with self.assertRaises(ValueError):
            scorer.normalize('a' * 3001)
        result = json.dumps(scorer.score({'cases': [case('secretfixture', 'redactedfixture')]}))
        self.assertNotIn('secretfixture', result)
        self.assertNotIn('redactedfixture', result)

    def test_cli_invalid_utf8_has_fixed_safe_error(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'synthetic.json'
            source.write_bytes(b'\xff\xfe')
            error = io.StringIO()
            with patch.object(sys, 'argv', ['score', str(source)]), contextlib.redirect_stderr(error):
                self.assertEqual(scorer.main(), 2)
            self.assertEqual(error.getvalue(),
                             'SCORING_FAILED: invalid, incomplete or unreadable private input.\n')
            self.assertNotIn(directory, error.getvalue())

    def test_cli_success_counts_only(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'synthetic.json'
            source.write_text(json.dumps({'cases': [case()]}), encoding='utf-8')
            output = io.StringIO()
            with patch.object(sys, 'argv', ['score', str(source)]), contextlib.redirect_stdout(output):
                self.assertEqual(scorer.main(), 0)
            self.assertEqual(json.loads(output.getvalue())['overall']['WER']['N'], 2)


if __name__ == '__main__':
    unittest.main()
