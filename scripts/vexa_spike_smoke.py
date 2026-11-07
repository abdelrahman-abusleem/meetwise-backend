#!/usr/bin/env python3
"""Opt-in Vexa Google Meet smoke probe. Does not print transcript or credentials.

Default: offline preflight. Live execution explicitly requires --execute,
--consent-confirmed, VEXA_API_BASE, VEXA_API_KEY, and MEET_URL.
Not a replacement for S1 webhook, Vexa admission, language quality, or Docker tests.
"""
from __future__ import annotations
import argparse
import collections
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def require_meet_id(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'meet.google.com':
        raise ValueError('MEET_URL must be an https://meet.google.com/... link')
    parts = [p for p in parsed.path.split('/') if p]
    if len(parts) != 1 or not re.fullmatch(r'[a-zA-Z0-9-]{3,100}', parts[0]):
        raise ValueError('MEET_URL is missing a valid native meeting code')
    return parts[0]


def validated_base(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('VEXA_API_BASE must be a simple base URL')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'}):
        raise ValueError('Only https Vexa gateways (or local http for test) are allowed')
    return url.rstrip('/')


def request(base: str, key: str, method: str, route: str, body: dict | None = None):
    encoded = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(base + route, data=encoded, method=method,
        headers={'X-API-Key': key, 'Accept':'application/json', **({'Content-Type':'application/json'} if encoded else {})})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = response.read(2_000_000)
            return response.status, (json.loads(data) if data else {})
    except urllib.error.HTTPError as exc:

        return exc.code, {}


def main() -> int:
    ap = argparse.ArgumentParser(description='Vexa spike smoke test; no transcript contents are logged.')
    ap.add_argument('--execute', action='store_true', help='Actually use the Vexa API and join the meeting.')
    ap.add_argument('--consent-confirmed', action='store_true', help='All participants consented before capture.')
    ap.add_argument('--duration-seconds', type=int, default=60, help='Keep test bot alive for 10 to 180 seconds.')
    args = ap.parse_args()
    if not args.execute:
        print('PREFLIGHT ONLY: no requests made. LIVE requires --execute --consent-confirmed and env VEXA_API_BASE, VEXA_API_KEY, MEET_URL.')
        print('S1 checklist: consenting participants, host to admit bot, sample Arabic-English meeting, supervised stop, independent event/webhook and Docker tests.')
        return 0
    if not args.consent_confirmed:
        print('BLOCKED: informed consent must be confirmed before capture.', file=sys.stderr)
        return 2
    if args.duration_seconds < 10 or args.duration_seconds > 180:
        print('BLOCKED: duration must be between 10 and 180 seconds.', file=sys.stderr)
        return 2
    try:
        base = validated_base(os.environ['VEXA_API_BASE'])
        key = os.environ['VEXA_API_KEY']
        meeting_id = require_meet_id(os.environ['MEET_URL'])
        if len(key) < 8: raise ValueError('VEXA_API_KEY unavailable or too short')
    except (ValueError, KeyError) as exc:
        print('BLOCKED: invalid or missing required configuration (no key values printed).', file=sys.stderr)
        return 2
    route='/transcripts/google_meet/'+urllib.parse.quote(meeting_id, safe='')
    bot_route='/bots/google_meet/'+urllib.parse.quote(meeting_id, safe='')
    bot_started=False
    observed_segments=False
    try:
        code, _ = request(base,key,'POST','/bots', {'platform':'google_meet','native_meeting_id':meeting_id,'bot_name':'MeetWise-S1-Test','transcribe_enabled':True,'recording_enabled':False,'task':'transcribe'})
        print('POST /bots:',code)
        if not 200 <= code < 300:
            print('FAILED: provider did not accept the bot. No further requests made.')
            return 1
        bot_started=True
        start=time.monotonic()
        while time.monotonic()-start < args.duration_seconds:
            time.sleep(min(10, max(0, args.duration_seconds-(time.monotonic()-start))))
            status, data=request(base,key,'GET',route)
            if status != 200:
                print('GET transcript HTTP:',status)
                continue
            seg=data.get('segments',[]) if isinstance(data,dict) else []
            if not isinstance(seg,list):seg=[]
            if seg: observed_segments=True
            languages=collections.Counter(str(s.get('language','unknown'))[:16] for s in seg if isinstance(s,dict))
            print('Transcript HTTP: 200 | segments:',len(seg), '| languages:',dict(languages),'| completed segments:',sum(bool(s.get('completed')) for s in seg if isinstance(s,dict)))
        if not observed_segments:
            print('INCONCLUSIVE: no transcript segments observed; live capture NOT VERIFIED.')
            return 3
        print('SMOKE OBSERVED segments, not a pass for S1 quality, scheduler, webhook, stop or recovery acceptance.')
        return 0
    except Exception as exc:
        print('PROBE FAILURE:',type(exc).__name__,'(no secrets/transcript printed)',file=sys.stderr)
        return 1
    finally:
        if bot_started:
            try:
                status,_=request(base,key,'DELETE',bot_route)
                print('DELETE /bots/...:',status,'(operator should confirm bot is gone)')
            except Exception:
                print('WARNING: bot stop unconfirmed; manually stop from Vexa console.',file=sys.stderr)


if __name__=='__main__':
    raise SystemExit(main())
