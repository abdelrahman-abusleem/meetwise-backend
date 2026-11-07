"""Fictional synthetic data only; no provider, audio or participant content."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import platform
import sys
import tempfile
import unicodedata
import unittest
from unittest.mock import patch

import s1_quality_report as report
import s1_quality_score as scorer


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def fixture():
    clips, cases = [], []
    for group, prefix in [('AR-EG', 'AR'), ('EN', 'EN'), ('MIX', 'MIX')]:
        for index in range(1, 4):
            case_id = f'{prefix}_{index}'
            text = 'fictional alpha beta'
            clips.append(dict(id=case_id, group=group, durationSeconds=120,
                              referenceSha256=digest(text)))
            cases.append(dict(id=case_id, complete=True, reference=text, hypothesis=text,
                              observations=dict(speakerCorrectWords=3, speakerCount=2,
                                                admissionMs=60000, sessionMs=240000,
                                                stopMs=15000, terminalMs=60000,
                                                postLeaveObservationMs=30000,
                                                postLeaveNewCapture=0)))
    manifest = dict(schema=report.SCHEMA, runId='SYNTHETIC_1', protocol=scorer.PROTOCOL,
                    scorerSha256=report.scorer_hash(), reporterSha256=report.reporter_hash(), python=platform.python_version(),
                    unicode=unicodedata.unidata_version, clips=clips)
    payload = dict(runId='SYNTHETIC_1', cases=cases,
                   silence=dict(durationSeconds=30, lexicalTokens=0),
                   overlap=dict(durationSeconds=30, observed=True),
                   evidence=dict(custodyRecorded=True, disposition='QUARANTINED_PENDING_OWNER'))
    return manifest, payload


class QualityReportTests(unittest.TestCase):
    def test_nine_clips_never_grant_acceptance(self):
        manifest, payload = fixture()
        result = report.build_report(manifest, payload)
        self.assertEqual(len(result['measurement']['cases']), 9)
        self.assertEqual(set(result['conditionalLimits']), {'EN', 'AR-EG', 'MIX', 'overall'})
        self.assertFalse(result['s1Pass'])
        self.assertEqual(result['perClipCaps'], 'PENDING_OWNER_FREEZE')
        self.assertEqual(result['protocolStatus'], 'PROPOSED_NOT_APPROVED')
        self.assertEqual(result['conditionalMetricOutcome'], 'WITHIN_CONDITIONAL_MAXIMA')

    def test_exact_threshold_comparison(self):
        for percent in [7, 12, 15, 18, 25, 30, 35]:
            self.assertTrue(report.within_limit(dict(S=percent, D=0, I=0, N=100), percent))
            self.assertFalse(report.within_limit(dict(S=percent, D=0, I=1, N=100), percent))

    def test_missing_or_extra_clip_rejected(self):
        for side in ['manifest', 'payload']:
            manifest, payload = fixture()
            (manifest['clips'] if side == 'manifest' else payload['cases']).pop()
            with self.assertRaises(ValueError):
                report.build_report(manifest, payload)

    def test_duplicate_and_unknown_clip_rejected(self):
        for case_id in ['EN_1', 'EN_4']:
            manifest, payload = fixture()
            payload['cases'][0]['id'] = case_id
            with self.assertRaises(ValueError):
                report.build_report(manifest, payload)

    def test_wrong_group_and_duration_rejected(self):
        for key, value in [('group', 'EN'), ('durationSeconds', 119), ('durationSeconds', True)]:
            manifest, payload = fixture()
            manifest['clips'][0][key] = value
            with self.assertRaises(ValueError):
                report.build_report(manifest, payload)

    def test_partial_and_empty_reference_rejected(self):
        manifest, payload = fixture()
        payload['cases'][0]['complete'] = False
        with self.assertRaises(ValueError):
            report.build_report(manifest, payload)
        manifest, payload = fixture()
        payload['cases'][0]['reference'] = '...'
        manifest['clips'][0]['referenceSha256'] = digest('...')
        with self.assertRaises(ValueError):
            report.build_report(manifest, payload)

    def test_identity_mismatch_rejected(self):
        for key, value in [('schema', 'future'), ('protocol', 'future'), ('scorerSha256', '0'*64), ('reporterSha256', '0'*64),
                           ('python', '0.0'), ('unicode', '0.0'), ('runId', '../private')]:
            manifest, payload = fixture()
            manifest[key] = value
            with self.assertRaises(ValueError):
                report.build_report(manifest, payload)

    def test_reference_and_run_replay_mismatch_rejected(self):
        manifest, payload = fixture()
        payload['cases'][0]['reference'] += ' changed'
        with self.assertRaises(ValueError):
            report.build_report(manifest, payload)
        manifest, payload = fixture()
        payload['runId'] = 'SYNTHETIC_2'
        with self.assertRaises(ValueError):
            report.build_report(manifest, payload)

    def test_group_failure_cannot_hide_in_overall(self):
        manifest, payload = fixture()

        payload['cases'][3]['hypothesis'] = 'fictional alpha other'
        result = report.build_report(manifest, payload)
        self.assertFalse(result['conditionalLimits']['EN']['withinCER'])
        self.assertTrue(result['conditionalLimits']['overall']['withinCER'])
        self.assertEqual(result['conditionalMetricOutcome'], 'EXCEEDS_CONDITIONAL_MAXIMA')

    def test_micro_not_macro(self):
        manifest, payload = fixture()
        payload['cases'][0]['reference'] = 'a'
        payload['cases'][0]['hypothesis'] = ''
        payload['cases'][0]['observations']['speakerCorrectWords'] = 0
        manifest['clips'][0]['referenceSha256'] = digest('a')
        result = report.build_report(manifest, payload)['measurement']
        self.assertEqual(result['overall']['WER']['N'], 25)
        self.assertEqual(result['overall']['WER']['ratio'], 1/25)
        self.assertEqual(result['macro']['WER'], 1/9)

    def test_invalid_observations(self):
        for key, value in [('speakerCorrectWords', 4), ('speakerCount', True),
                           ('stopMs', -1), ('sessionMs', 119999), ('terminalMs', float('nan')),
                           ('admissionMs', 86400001), ('postLeaveNewCapture', '0')]:
            manifest, payload = fixture()
            payload['cases'][0]['observations'][key] = value
            with self.assertRaises(ValueError):
                report.build_report(manifest, payload)

    def test_proposed_observation_failures_visible(self):
        manifest, payload = fixture()
        payload['cases'][0]['observations'].update(speakerCorrectWords=2, speakerCount=1,
             admissionMs=60001, sessionMs=240001, stopMs=15001, terminalMs=60001,
             postLeaveObservationMs=29999, postLeaveNewCapture=1)
        payload['silence']['lexicalTokens'] = 1
        payload['overlap']['observed'] = False
        payload['evidence']['custodyRecorded'] = False
        result = report.build_report(manifest, payload)
        self.assertTrue(all(value is False for value in result['proposedObservations']['clips'][0]['checks'].values()))
        self.assertFalse(result['proposedObservations']['silenceNoLexicalOutput'])
        self.assertFalse(result['proposedObservations']['overlapObserved'])
        self.assertFalse(result['proposedObservations']['custodyRecorded'])
        self.assertEqual(result['proposedObservations']['status'], 'PROPOSED_CALLER_REPORTED_NOT_INDEPENDENT_EVIDENCE')

    def test_no_automatic_deletion_or_approval_fields(self):
        manifest, payload = fixture()
        payload['evidence']['disposition'] = 'DELETED'
        with self.assertRaises(ValueError):
            report.build_report(manifest, payload)
        manifest, payload = fixture()
        manifest['ownerApproved'] = True
        with self.assertRaises(ValueError):
            report.build_report(manifest, payload)

    def test_diagnostics_cannot_substitute_and_must_be_valid(self):
        for section, key, value in [('silence','durationSeconds',120), ('overlap','durationSeconds',120),
                                    ('silence','lexicalTokens',-1), ('overlap','observed',1)]:
            manifest, payload = fixture()
            payload[section][key] = value
            with self.assertRaises(ValueError):
                report.build_report(manifest, payload)

    def test_deterministic_safe_report(self):
        manifest, payload = fixture()
        first = report.build_report(manifest, payload)
        payload['cases'].reverse()
        manifest['clips'].reverse()

        second = report.build_report(manifest, payload)
        self.assertEqual(first['measurement'], second['measurement'])
        encoded = json.dumps(first)
        self.assertNotIn('fictional', encoded)
        self.assertNotIn('alpha', encoded)
        self.assertNotIn(str(Path(__file__).parent), encoded)
        self.assertEqual(first, report.build_report(*fixture()))

    def test_cli_strict_json_and_generic_error(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, payload = fixture()
            manifest_path, input_path = Path(directory)/'manifest.json', Path(directory)/'input.json'
            manifest_path.write_text(json.dumps(manifest), encoding='utf8')
            for text in ['{"private":"SECRET", "private":2}', '{"x":NaN}', 'x'*262145, '{', '\ud800']:
                input_path.write_bytes(text.encode('utf8', errors='surrogatepass'))
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(sys, 'argv', ['report', str(manifest_path), str(input_path)]), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(report.main(), 2)
                self.assertEqual(stdout.getvalue(), '')
                self.assertEqual(stderr.getvalue(), 'REPORT_FAILED: invalid, incomplete or unreadable private input.\n')

    def test_cli_success(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, payload = fixture()
            paths = [Path(directory)/'manifest.json', Path(directory)/'input.json']
            for path, value in zip(paths, [manifest, payload]):
                path.write_text(json.dumps(value), encoding='utf8')
            stdout = io.StringIO()
            with patch.object(sys, 'argv', ['report', *map(str, paths)]), contextlib.redirect_stdout(stdout):
                self.assertEqual(report.main(), 0)
            self.assertFalse(json.loads(stdout.getvalue())['s1Pass'])


if __name__ == '__main__':
    unittest.main()
