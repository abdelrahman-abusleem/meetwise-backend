"""Fail-closed local STT entrypoint; no persistent application logs."""
import hashlib
import http.client
import json
import logging
import os
from pathlib import Path
import re
import sys


def validate_runtime(root=Path('/models/small'), secret=Path('/run/secrets/stt_token'), lock_file=Path('/opt/s1/lock.json')):
    token = secret.read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('Private STT token required')
    lock = json.loads(lock_file.read_text())
    for item in lock['model']['files']:
        name = item['name']
        if not re.fullmatch(r'[a-z_.]+', name):
            raise ValueError('Invalid model path')
        file = root / name
        if file.is_symlink() or file.stat().st_size != item['size']:
            raise ValueError('Model identity mismatch')
        with file.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                raise ValueError('Model identity mismatch')
    os.environ.update(API_TOKEN=token, MODEL_SIZE=str(root), DEVICE='cpu', COMPUTE_TYPE='int8',
                      HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')


def main():
    if sys.argv[1:] == ['--health']:
        connection = http.client.HTTPConnection('127.0.0.1', 8000, timeout=3)
        try:
            connection.request('GET', '/health')
            response = connection.getresponse()
            body = json.loads(response.read(4096))
            return 0 if response.status == 200 and body.get('status') == 'healthy' and body.get('model') == '/models/small' else 1
        finally:
            connection.close()
    validate_runtime()
    logging.disable(logging.CRITICAL)
    import uvicorn
    uvicorn.run('transcription.main:app', host='0.0.0.0', port=8000,
                access_log=False, log_config=None, log_level='critical')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('STT_STARTUP_FAILED', file=sys.stderr)
        sys.exit(2)
