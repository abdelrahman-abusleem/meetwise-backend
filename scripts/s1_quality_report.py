#!/usr/bin/env python3
"""Offline nine-clip measurement, never S1 acceptance. Synthetic inputs only now."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import sys
import unicodedata

import s1_quality_score as scorer

SCHEMA = 's1-nine-clip-v1-proposed'
CLIPS = {f'{prefix}_{index}': group
         for group, prefix in [('AR-EG', 'AR'), ('EN', 'EN'), ('MIX', 'MIX')]
         for index in range(1, 4)}
LIMITS = {'AR-EG': (30, 15), 'EN': (15, 7), 'MIX': (35, 18), 'overall': (25, 12)}
MAX_INPUT_BYTES = 262144
OBSERVATIONS = {'speakerCorrectWords', 'speakerCount', 'admissionMs', 'sessionMs',
                'stopMs', 'terminalMs', 'postLeaveObservationMs', 'postLeaveNewCapture'}


def scorer_hash() -> str:
    return hashlib.sha256(Path(scorer.__file__).read_bytes()).hexdigest()


def reporter_hash() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def digest_json(value: dict) -> str:
    encoded = json.dumps(value, ensure_ascii=True, allow_nan=False,
                         sort_keys=True, separators=(',', ':')).encode('ascii')
    return hashlib.sha256(encoded).hexdigest()


def fields(value: dict, expected: set[str]) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError('Invalid fields')


def bounded_integer(value: int, maximum: int = 86400000) -> None:
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('Invalid bounded integer')


def index_clips(items: list, expected_fields: set[str]) -> dict:
    if not isinstance(items, list) or len(items) != 9:
        raise ValueError('Nine mandatory clips required')
    indexed = {}
    for item in items:
        fields(item, expected_fields)
        case_id = item['id']
        if not isinstance(case_id, str) or case_id not in CLIPS or case_id in indexed:
            raise ValueError('Invalid mandatory clip identity')
        indexed[case_id] = item
    if set(indexed) != set(CLIPS):
        raise ValueError('Missing mandatory clip')
    return indexed


def validate_manifest(manifest: dict) -> dict:
    fields(manifest, {'schema', 'runId', 'protocol', 'scorerSha256', 'reporterSha256', 'python', 'unicode', 'clips'})
    expected = {'schema': SCHEMA, 'protocol': scorer.PROTOCOL, 'scorerSha256': scorer_hash(),
                'reporterSha256': reporter_hash(), 'python': platform.python_version(),
                'unicode': unicodedata.unidata_version}
    if any(manifest[key] != value for key, value in expected.items()):
        raise ValueError('Frozen implementation mismatch')
    if (not isinstance(manifest['runId'], str)
            or not re.fullmatch(r'[A-Z][A-Z0-9_-]{0,31}', manifest['runId'])):
        raise ValueError('Invalid run pseudonym')
    clips = index_clips(manifest['clips'], {'id', 'group', 'durationSeconds', 'referenceSha256'})
    for case_id, clip in clips.items():
        if (clip['group'] != CLIPS[case_id] or type(clip['durationSeconds']) is not int
                or clip['durationSeconds'] != 120 or not isinstance(clip['referenceSha256'], str)
                or not re.fullmatch(r'[a-f0-9]{64}', clip['referenceSha256'])):
            raise ValueError('Invalid frozen clip')
    return clips


def validate_observations(observations: dict, words: int) -> None:
    fields(observations, OBSERVATIONS)
    for value in observations.values():
        bounded_integer(value)
    if (observations['speakerCorrectWords'] > words or observations['sessionMs'] < 120000
            or observations['admissionMs'] > observations['sessionMs']):
        raise ValueError('Inconsistent reported observations')


def prepare_cases(manifest_clips: dict, payload: dict) -> list[dict]:
    indexed = index_clips(payload['cases'], {'id', 'complete', 'reference', 'hypothesis', 'observations'})
    cases = []
    for case_id, group in CLIPS.items():
        case = indexed[case_id]
        if case['complete'] is not True:
            raise ValueError('Incomplete mandatory clip')


        reference = scorer.normalize(case['reference'])
        scorer.normalize(case['hypothesis'])
        actual_digest = hashlib.sha256(case['reference'].encode('utf-8', errors='strict')).hexdigest()
        if not reference or actual_digest != manifest_clips[case_id]['referenceSha256']:
            raise ValueError('Unscorable or changed reference')
        validate_observations(case['observations'], len(reference.split(' ')))
        cases.append(dict(id=case_id, group=group, complete=True,
                          reference=case['reference'], hypothesis=case['hypothesis']))
    return cases


def validate_diagnostics(payload: dict) -> None:
    fields(payload['silence'], {'durationSeconds', 'lexicalTokens'})
    fields(payload['overlap'], {'durationSeconds', 'observed'})
    for name in ['silence', 'overlap']:
        duration = payload[name]['durationSeconds']
        if type(duration) is not int or duration != 30:
            raise ValueError('Invalid diagnostic duration')
    bounded_integer(payload['silence']['lexicalTokens'])
    if type(payload['overlap']['observed']) is not bool:
        raise ValueError('Invalid diagnostic observation')
    fields(payload['evidence'], {'custodyRecorded', 'disposition'})
    if (type(payload['evidence']['custodyRecorded']) is not bool
            or payload['evidence']['disposition'] not in ('QUARANTINED_PENDING_OWNER', 'NOT_VERIFIED')):
        raise ValueError('Invalid evidence custody state')


def within_limit(metric: dict, percent: int) -> bool:
    """Inclusive comparison using integer counts, without rounded percentages."""
    return 100 * (metric['S'] + metric['D'] + metric['I']) <= percent * metric['N']


def conditional_limits(measurement: dict) -> dict:
    result = {}
    for group, (wer, cer) in LIMITS.items():
        metrics = measurement['overall'] if group == 'overall' else measurement['groups'][group]
        result[group] = dict(maxWERPercent=wer, maxCERPercent=cer,
                             withinWER=within_limit(metrics['WER'], wer),
                             withinCER=within_limit(metrics['CER'], cer),
                             authority='CONDITIONALLY_APPROVED_NOT_MEASURED_ACCEPTANCE')
    return result


def proposed_observations(payload: dict, measurement: dict) -> dict:
    indexed = {case['id']: case for case in payload['cases']}
    clips = []
    for case in measurement['cases']:
        values = indexed[case['id']]['observations']
        words = case['WER']['N']
        checks = dict(speakerAtLeast95Percent=100 * values['speakerCorrectWords'] >= 95 * words,
                      atLeastTwoSpeakers=values['speakerCount'] >= 2,
                      admissionAtMost60Seconds=values['admissionMs'] <= 60000,
                      sessionAtMost240Seconds=values['sessionMs'] <= 240000,
                      stopAtMost15Seconds=values['stopMs'] <= 15000,
                      terminalAtMost60Seconds=values['terminalMs'] <= 60000,
                      noNewCaptureObservedFor30Seconds=(values['postLeaveObservationMs'] >= 30000
                                                        and values['postLeaveNewCapture'] == 0))
        clips.append(dict(id=case['id'], reported=values, referenceWords=words, checks=checks,
                          proposedWordCount180To240=180 <= words <= 240))
    return dict(status='PROPOSED_CALLER_REPORTED_NOT_INDEPENDENT_EVIDENCE', clips=clips,
                silenceNoLexicalOutput=payload['silence']['lexicalTokens'] == 0,
                silenceReported=payload['silence'], overlapObserved=payload['overlap']['observed'],
                overlapReported=payload['overlap'], custodyRecorded=payload['evidence']['custodyRecorded'],
                disposition=payload['evidence']['disposition'],
                mixedComposition='REQUIRES_PRIVATE_HUMAN_VERIFICATION_NOT_COMPUTED',
                actualUtterancesAndConsent='NOT_VERIFIED_BY_THIS_TOOL')


def build_report(manifest: dict, payload: dict) -> dict:
    manifest_clips = validate_manifest(manifest)
    fields(payload, {'runId', 'cases', 'silence', 'overlap', 'evidence'})
    if payload['runId'] != manifest['runId']:
        raise ValueError('Run mismatch')
    validate_diagnostics(payload)
    cases = prepare_cases(manifest_clips, payload)
    measurement = scorer.score({'cases': cases})
    limits = conditional_limits(measurement)
    within_all = all(item['withinWER'] and item['withinCER'] for item in limits.values())
    return dict(status='OFFLINE_MEASUREMENT_NOT_S1_ACCEPTANCE', s1Pass=False,
                runId=manifest['runId'], manifestSha256=digest_json(manifest), inputSha256=digest_json(payload),
                schema=SCHEMA, scorerSha256=scorer_hash(), reporterSha256=reporter_hash(),
                protocolStatus='PROPOSED_NOT_APPROVED',
                perClipCaps='PENDING_OWNER_FREEZE',
                acceptance='BLOCKED_PENDING_OWNER_FREEZE_AND_LIVE_EVIDENCE',
                conditionalMetricOutcome=('WITHIN_CONDITIONAL_MAXIMA' if within_all
                                          else 'EXCEEDS_CONDITIONAL_MAXIMA'),
                measurement=measurement, conditionalLimits=limits,
                proposedObservations=proposed_observations(payload, measurement))


def metric_cells(value: dict) -> str:
    """Display precision never participates in acceptance comparisons."""
    counts = '/'.join(str(value[key]) for key in ('S', 'D', 'I', 'N'))
    return f"{counts} | {100 * value['ratio']:.6f}%"


def observation_outcome(value: bool) -> str:
    return 'MET(PASS_PROPOSED)' if value else 'NOT_MET(FAIL_PROPOSED)'


def render_markdown(result: dict) -> str:
    """Render only the freshly validated build_report result, never arbitrary JSON."""
    measurement = result['measurement']
    lines = ['# S1 quality measurement', '',
             'No S1 acceptance. **S1 LIVE BLOCKED; Phase 3 NO-GO.**', '',
             f"Run: `{result['runId']}`; status: `{result['status']}`.",
             f"Acceptance: `{result['acceptance']}`; protocol: `{result['protocolStatus']}`.",
             f"Per-clip thresholds: `{result['perClipCaps']}`; outcome: BLOCKED.",
             'PASS/FAIL below concern conditional metric limits or proposed observations only.',
             'Missing/partial/invalid input fails validation; metrics are NOT_MEASURED, never PASS.',
             'Display percentages are rounded; comparisons use exact integer counts.', '',
             '## Per-clip measurements', '',
             '| Clip | Group | WER S/D/I/N | WER | CER S/D/I/N | CER | Clip acceptance |',
             '|---|---|---|---|---|---|---|']
    for case in measurement['cases']:
        lines.append(f"| {case['id']} | {case['group']} | {metric_cells(case['WER'])} | "
                     f"{metric_cells(case['CER'])} | BLOCKED: PENDING_OWNER_FREEZE |")
    lines.extend(['', '## Conditionally approved group/overall limits', '',
                  f"Metric outcome: `{result['conditionalMetricOutcome']}`; this is not S1 PASS.", '',
                  '| Group | WER S/D/I/N | WER | Max WER | WER outcome | CER S/D/I/N | CER | Max CER | CER outcome |',
                  '|---|---|---|---|---|---|---|---|---|'])
    for group, limits in result['conditionalLimits'].items():
        scores = measurement['overall'] if group == 'overall' else measurement['groups'][group]
        wer_outcome = 'PASS_CONDITIONAL' if limits['withinWER'] else 'FAIL_CONDITIONAL'
        cer_outcome = 'PASS_CONDITIONAL' if limits['withinCER'] else 'FAIL_CONDITIONAL'
        lines.append(f"| {group} | {metric_cells(scores['WER'])} | {limits['maxWERPercent']}% | "
                     f"{wer_outcome} | {metric_cells(scores['CER'])} | {limits['maxCERPercent']}% | {cer_outcome} |")
    lines.extend(['', f"Secondary macro: WER={100 * measurement['macro']['WER']:.6f}%; "
                  f"CER={100 * measurement['macro']['CER']:.6f}%. Micro counts above remain primary.", '',
                  '## Proposed caller-reported observations', '',
                  result['proposedObservations']['status'],
                  'All observation criteria below remain PROPOSED_NOT_APPROVED; no independent evidence is inferred.', ''])
    observations = result['proposedObservations']
    for clip in observations['clips']:
        checks = '; '.join(name + '=' + observation_outcome(value) for name, value in clip['checks'].items())
        values = '; '.join(name + '=' + str(value) for name, value in clip['reported'].items())
        lines.extend([f"- {clip['id']}: {checks}; wordCount180To240="
                      f"{observation_outcome(clip['proposedWordCount180To240'])}.",
                      f"  Reported: {values}; referenceWords={clip['referenceWords']}."])
    for name in ['silenceNoLexicalOutput', 'overlapObserved', 'custodyRecorded']:
        lines.append(f"- {name}={observation_outcome(observations[name])}.")
    lines.extend([f"- Silence: durationSeconds={observations['silenceReported']['durationSeconds']}; "
                  f"lexicalTokens={observations['silenceReported']['lexicalTokens']}.",
                  f"- Overlap: durationSeconds={observations['overlapReported']['durationSeconds']}; diagnostic only.",
                  f"- Disposition: {observations['disposition']}; no automatic deletion.",
                  f"- MIX composition: NOT_MEASURED; {observations['mixedComposition']}.",
                  f"- Actual utterances and consent: NOT_MEASURED; {observations['actualUtterancesAndConsent']}.", '',
                  '## Reproducibility and limitations', '',
                  f"Schema: `{result['schema']}`; protocol: `{measurement['protocol']}`; "
                  f"Python: `{measurement['runtime']}`; UCD: `{measurement['unicode']}`."])
    for name in ['manifestSha256', 'inputSha256', 'scorerSha256', 'reporterSha256']:
        lines.append(f"- {name}: `{result[name]}`")
    lines.extend(['', 'No reference/hypothesis text, lexical alignments, private paths or human identities are rendered.',
                  'Keep reports private until independently sanitized/reviewed. Hashes bind bytes, not consent or approval.',
                  'No live/provider, deployed compatibility, model accuracy or hosted-CI acceptance is established.'])
    return '\n'.join(lines)


def unique_object(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def reject_constant(_: str) -> None:
    raise ValueError('Nonfinite JSON value')


def read_private_json(path: Path) -> dict:
    with path.open('rb') as stream:
        raw = stream.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError('Oversized input')
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=unique_object,
                      parse_constant=reject_constant)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path, help='Private frozen manifest, not an approval record')
    parser.add_argument('input', type=Path, help='Private bounded UTF-8 measurements')
    parser.add_argument('--format', choices=('json', 'markdown'), default='json',
                        help='Private output format; neither format grants S1 acceptance')
    args = parser.parse_args()
    try:
        result = build_report(read_private_json(args.manifest), read_private_json(args.input))
        output = (render_markdown(result) if args.format == 'markdown'
                  else json.dumps(result, ensure_ascii=True, allow_nan=False))
    except (OSError, ValueError, TypeError, RecursionError):
        message = 'REPORT_FAILED: invalid, incomplete or unreadable private input.'
        if args.format == 'markdown':
            message += ' Metrics=NOT_MEASURED; S1=BLOCKED.'
        print(message, file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
