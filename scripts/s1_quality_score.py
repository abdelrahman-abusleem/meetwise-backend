#!/usr/bin/env python3
"""Offline proposed S1 metric scorer. No network, audio, credentials or GO decision."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import re
import sys
import unicodedata

PROTOCOL = 's1-primary-nfc-v1-proposed'
GROUPS = ('AR-EG', 'EN', 'MIX')
WHITE_SPACE = frozenset(chr(n) for n in (
    *range(9, 14), 32, 133, 160, 5760, *range(8192, 8203),
    8232, 8233, 8239, 8287, 12288,
))


def normalize(text: str) -> str:
    if not isinstance(text, str) or len(text) > 6000:
        raise ValueError('Invalid bounded text')
    output = []
    for character in unicodedata.normalize('NFC', text):
        category = unicodedata.category(character)
        if character in WHITE_SPACE or category.startswith('P'):
            output.append(' ')
        elif category.startswith('C'):
            raise ValueError('Unsupported Unicode character')
        elif 'A' <= character <= 'Z':
            output.append(character.lower())
        else:
            output.append(character)
    result = ' '.join(part for part in ''.join(output).split(' ') if part)
    if len(result) > 3000:
        raise ValueError('Normalized interval too large')
    return result


def edits(reference: list[str], hypothesis: list[str]) -> dict:
    """Unit-cost alignment, diagonal then deletion then insertion on ties.

    Retaining counts in two DP rows gives the same deterministic backtrace
    decisions without storing text or an unbounded full alignment matrix.
    """
    if not reference:
        raise ValueError('Empty reference is unscorable')

    previous = [(n, 0, 0, n) for n in range(len(hypothesis) + 1)]
    for i, expected in enumerate(reference, 1):
        current = [(i, 0, i, 0)]
        for j, actual in enumerate(hypothesis, 1):
            diagonal = previous[j - 1]
            substitution = int(expected != actual)
            choices = (
                (diagonal[0] + substitution, diagonal[1] + substitution,
                 diagonal[2], diagonal[3]),
                (previous[j][0] + 1, previous[j][1], previous[j][2] + 1,
                 previous[j][3]),
                (current[j - 1][0] + 1, current[j - 1][1],
                 current[j - 1][2], current[j - 1][3] + 1),
            )
            current.append(min(choices, key=lambda cell: cell[0]))
        previous = current
    _, substitutions, deletions, insertions = previous[-1]
    return metric(substitutions, deletions, insertions, len(reference))


def metric(substitutions: int, deletions: int, insertions: int, n: int) -> dict:
    return dict(S=substitutions, D=deletions, I=insertions, N=n,
                ratio=(substitutions + deletions + insertions) / n)


def aggregate(cases: list[dict], name: str) -> dict:
    totals = {key: sum(case[name][key] for case in cases)
              for key in ('S', 'D', 'I', 'N')}
    return metric(totals['S'], totals['D'], totals['I'], totals['N'])


def score(payload: dict) -> dict:
    if not isinstance(payload, dict) or set(payload) != {'cases'}:
        raise ValueError('Expected bounded cases object')
    cases = payload['cases']
    if not isinstance(cases, list) or not 1 <= len(cases) <= 32:
        raise ValueError('Invalid case count')
    scored, seen = [], set()
    for case in cases:
        if not isinstance(case, dict) or set(case) != {
            'id', 'group', 'complete', 'reference', 'hypothesis'
        }:
            raise ValueError('Invalid case fields')
        case_id = case['id']
        if (not isinstance(case_id, str)
                or not re.fullmatch(r'[A-Z][A-Z0-9_-]{0,31}', case_id)
                or case_id in seen or case['group'] not in GROUPS
                or case['complete'] is not True):
            raise ValueError('Invalid, duplicate or incomplete case')
        seen.add(case_id)
        reference, hypothesis = normalize(case['reference']), normalize(case['hypothesis'])
        scored.append(dict(id=case_id, group=case['group'],
                           WER=edits(reference.split() if reference else [],
                                     hypothesis.split() if hypothesis else []),
                           CER=edits(list(reference.replace(' ', '')),
                                     list(hypothesis.replace(' ', '')))))
    groups = {}
    for group in GROUPS:
        subset = [case for case in scored if case['group'] == group]
        groups[group] = (dict(cases=len(subset), WER=aggregate(subset, 'WER'),
                              CER=aggregate(subset, 'CER')) if subset else None)
    return dict(status='MEASUREMENT_ONLY_NOT_S1_ACCEPTANCE', protocol=PROTOCOL,
                runtime=platform.python_version(), unicode=unicodedata.unidata_version,
                cases=scored, groups=groups,
                overall=dict(WER=aggregate(scored, 'WER'), CER=aggregate(scored, 'CER')),
                macro=dict(WER=sum(c['WER']['ratio'] for c in scored) / len(scored),
                           CER=sum(c['CER']['ratio'] for c in scored) / len(scored)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='Private UTF-8 JSON; never commit it')
    args = parser.parse_args()
    try:
        with args.input.open('rb') as stream:
            content = stream.read(65537)
        if len(content) > 65536:
            raise ValueError('Input too large')
        result = score(json.loads(content.decode('utf-8', errors='strict')))
    except (OSError, ValueError, TypeError, RecursionError):
        print('SCORING_FAILED: invalid, incomplete or unreadable private input.', file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
