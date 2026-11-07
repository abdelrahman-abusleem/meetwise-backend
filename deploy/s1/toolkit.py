#!/usr/bin/env python3
"""Private offline S1 preparation. No meeting, capture, scheduling or stack-start API."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
SERVICES = ('admin-api', 'gateway', 'meeting-api', 'runtime', 'redis',
            'postgres', 'storage', 'storage-init')
SECRET_KEYS = ('DB_PASSWORD', 'ADMIN_TOKEN', 'INTERNAL_API_SECRET',
               'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'STT_TOKEN')
SECRET_MAPPING = dict(DB_PASSWORD='DB_PASSWORD', POSTGRES_PASSWORD='DB_PASSWORD',
                      ADMIN_TOKEN='ADMIN_TOKEN', ADMIN_API_TOKEN='ADMIN_TOKEN',
                      INTERNAL_API_SECRET='INTERNAL_API_SECRET',
                      MINIO_ACCESS_KEY='MINIO_ACCESS_KEY', ROOT_ACCESS_KEY='MINIO_ACCESS_KEY',
                      S3_ACCESS_KEY='MINIO_ACCESS_KEY', MINIO_SECRET_KEY='MINIO_SECRET_KEY',
                      ROOT_SECRET_KEY='MINIO_SECRET_KEY', S3_SECRET_KEY='MINIO_SECRET_KEY',
                      TRANSCRIPTION_SERVICE_TOKEN='STT_TOKEN')


def digest(file: Path) -> str:
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def owned_path(root: Path, relative: str) -> Path:
    parts = PurePosixPath(relative).parts
    if (not parts or PurePosixPath(relative).is_absolute()
            or any(p in ('.', '..') or not re.fullmatch(r'[A-Za-z0-9_.-]+', p) for p in parts)):
        raise ValueError('Invalid owned path')
    target = root.joinpath(*parts)
    for parent in [target, *target.parents]:
        if parent.is_symlink():
            raise ValueError('Symlink target rejected')
        if parent == root:
            break
    return target


def private_write(file: Path, value: str) -> None:
    with open(file, 'x', encoding='utf-8', newline='\n', opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        stream.write(value)


def attestation_template() -> dict:
    return dict(dedicated=False, private_roles_confirmed=False, engine_id='',
                scope='PRIVATE_OFFLINE_ONLY_NOT_LIVE')


def require_private_root(root: Path) -> None:
    if sys.platform != 'linux' or not root.is_dir():
        raise ValueError('Private Linux directory required')
    if any(p.is_symlink() for p in (root, *root.parents)):
        raise ValueError('Private root cannot traverse symlinks')
    metadata = root.stat()
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ValueError('Private directory must be owned by current user and mode0700')


def initialize(root: Path) -> None:
    if (root.exists() or root.is_symlink() or any(p.is_symlink() for p in root.parents)
            or any((p / '.git').exists() or p.name.lower() == 'onedrive' for p in root.parents)):
        raise ValueError('New private directory required')
    root.mkdir(mode=0o700)
    private_write(root / 'private.env', ''.join(k + '=' + secrets.token_hex(32) + '\n' for k in SECRET_KEYS))
    private_write(root / 'host-attestation.json', json.dumps(attestation_template(), indent=2))


def read_env(file: Path) -> dict:
    if file.is_symlink():
        raise ValueError('Symlink secret file rejected')
    raw = file.read_bytes()
    if len(raw) > 16384 or b'\r' in raw:
        raise ValueError('Invalid private environment')
    result = {}
    for line in raw.decode('ascii').splitlines():
        if not re.fullmatch(r'[A-Z_]+=[A-Za-z0-9_-]+', line):
            raise ValueError('Invalid private environment')
        key, value = line.split('=', 1)
        if key in result:
            raise ValueError('Duplicate private environment key')
        result[key] = value
    return result


def rotate_stt(root: Path) -> None:
    file = owned_path(root, 'private.env')
    env = read_env(file)
    if not set(SECRET_KEYS).issubset(env):
        raise ValueError('Incomplete private environment')
    private_write(root / ('private.env.backup-' + secrets.token_hex(8)), file.read_text())
    env['STT_TOKEN'] = secrets.token_hex(32)
    pending = root / ('private.env.pending-' + secrets.token_hex(8))
    private_write(pending, ''.join(k + '=' + v + '\n' for k, v in env.items()))
    os.replace(pending, file)
    token_file = owned_path(root, 'stt-token')
    if token_file.exists():
        pending_token = root / ('stt-token.pending-' + secrets.token_hex(8))
        private_write(pending_token, env['STT_TOKEN'])
        os.chmod(pending_token, 0o644)
        os.replace(pending_token, token_file)


def verify_files(root: Path, entries: list[dict]) -> None:
    for entry in entries:
        file = owned_path(root, entry.get('name', entry.get('path', '')))
        if (not file.is_file() or ('size' in entry and file.stat().st_size != entry['size'])
                or digest(file) != entry['sha256']):
            raise ValueError('Artifact identity mismatch')


def prepare_model_permissions(root: Path, entries: list[dict]) -> None:
    verify_files(root, entries)
    if root.is_symlink() or {p.name for p in root.iterdir()} != {e['name'] for e in entries}:
        raise ValueError('Unexpected model directory contents')
    for entry in entries:
        os.chmod(owned_path(root, entry['name']), 0o644)
    os.chmod(root, 0o755)


def fetch_files(root: Path, entries: list[dict]) -> None:
    """Explicit public artifact download, bounded per file, hash before promotion."""
    for entry in entries:
        name = entry.get('name', entry.get('path', ''))
        target = owned_path(root, name)
        if target.exists():
            verify_files(root, [entry])
            continue
        url = urllib.parse.urlsplit(entry['url'])
        if url.scheme != 'https' or url.hostname not in {'raw.githubusercontent.com', 'huggingface.co'}:
            raise ValueError('Unapproved artifact source')
        target.parent.mkdir(parents=True, exist_ok=True)
        pending = target.with_name(target.name + '.pending-' + secrets.token_hex(8))
        limit = entry.get('size', 8000000)
        started, total = time.monotonic(), 0
        try:
            request = urllib.request.Request(entry['url'], headers={'User-Agent': 'MeetWise-offline-preparation'})
            with urllib.request.urlopen(request, timeout=30) as response, pending.open('xb') as stream:
                if urllib.parse.urlsplit(response.url).scheme != 'https':
                    raise ValueError('Unsafe artifact redirect')
                while chunk := response.read1(1024 * 1024):
                    total += len(chunk)
                    if total > limit or time.monotonic() - started > 1200:
                        raise ValueError('Artifact transfer bound exceeded')
                    stream.write(chunk)
            verify_files(pending.parent, [dict(entry, name=pending.name)])
            if target.exists():
                raise ValueError('Concurrent artifact destination change')
            os.link(pending, target)
            pending.unlink()
        finally:
            if pending.exists():
                pending.unlink()


def immutable_image(value: str) -> bool:
    return bool(re.fullmatch(r'(?:[A-Za-z0-9./_-]+(?::[A-Za-z0-9_.-]+)?@)?sha256:[a-f0-9]{64}', value))


def secure_compose(base: dict, lock: dict) -> dict:
    result = dict(name='mw-s1', services={}, networks={'vexa': {'internal': True}}, volumes={})
    images = lock['images']
    dependency = {v['tag'].split(':')[0]: v['tag'].split(':')[0] + '@' + v['digest'] for v in lock['dependencies']}
    for name in SERVICES:
        service = copy.deepcopy(base['services'][name])
        old_image = service['image']
        repository = old_image.split('@')[0].split(':')[0]
        service['image'] = images.get(repository, dependency.get(repository, old_image))
        if not immutable_image(service['image']):
            raise ValueError('Mutable service image rejected')
        for field in ('build', 'ports', 'profiles', 'restart'):
            service.pop(field, None)
        service.update(logging={'driver': 'none'}, labels={'meetwise.s1': 'private-offline'},
                       networks=['vexa'], restart='no', stop_grace_period='15s', platform='linux/amd64')
        service['healthcheck'] = dict(service.get('healthcheck', {}), timeout='5s', retries=5, start_period='60s')
        env = service.setdefault('environment', {})
        for key in list(env):
            if key in SECRET_MAPPING:
                env[key] = '${' + SECRET_MAPPING[key] + ':?private secret required}'
            elif any(part in key for part in ('PASSWORD', 'TOKEN', 'SECRET', 'ACCESS_KEY', 'API_KEY', 'CREDENTIALS')):
                env[key] = ''
        for key in ('VEXA_FLOWS_API_URL', 'AGENT_API_URL', 'MCP_URL', 'VEXA_SYSTEM_WEBHOOK_URL'):
            if key in env:
                env[key] = ''
        env['LOG_LEVEL'] = 'error'
        for volume in service.get('volumes', []):
            if volume.get('type') == 'bind':
                if name == 'runtime' and volume.get('source') == '/var/run/docker.sock':
                    continue
                if name == 'runtime' and volume.get('source') == '/dev/null' and volume.get('target') == '/var/lib/vexa/host-claude-credentials':
                    continue
                if name == 'storage-init' and volume.get('target', '').startswith('/vexa-storage-tools'):
                    volume['source'] = './storage_init.py'
                    volume['target'] = '/vexa-storage-tools/storage_init.py'
                    volume['read_only'] = True
                    continue
                raise ValueError('Unapproved host bind mount')
            if volume.get('type') == 'volume':
                result['volumes'][volume['source']] = {}
        result['services'][name] = service
    runtime = result['services']['runtime']['environment']
    runtime.update(BROWSER_IMAGE=images['vexaai/vexa-bot'], DOCKER_NETWORK='mw-s1_vexa')
    runtime.update(AGENT_IMAGE=images.get('vexaai/v012-agent-worker', ''),
                   AGENT_WORKER_IMAGE=images.get('vexaai/v012-agent-worker', ''))
    meeting = result['services']['meeting-api']['environment']
    meeting.update(RECORDING_ENABLED='false', TRANSCRIBE_ENABLED='false',
                   TRANSCRIPTION_SERVICE_URL='http://stt:8000', TRANSCRIPTION_MODEL='small')
    image = lock['sttImage']
    if not immutable_image(image):
        raise ValueError('STT image receipt required')
    result['services']['stt'] = dict(
        image=image, platform='linux/amd64', user='10001:10001', read_only=True,
        entrypoint=['python', '/opt/s1/stt_entry.py'],
        environment=dict(MODEL_SIZE='/models/small', DEVICE='cpu', COMPUTE_TYPE='int8',
                         HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONPATH='/app/src',
                         TRANSCRIPTION_TIMEOUT_S='120', MAX_ACTIVE_REQUESTS='1'),
        volumes=[dict(type='bind', source='./model', target='/models/small', read_only=True)],
        secrets=['stt_token'], tmpfs=['/tmp:rw,noexec,nosuid,size=128m,mode=1777'],
        cap_drop=['ALL'], security_opt=['no-new-privileges:true'], networks=['vexa'],
        logging={'driver': 'none'}, labels={'meetwise.s1': 'private-offline'}, restart='no',
        stop_grace_period='15s', mem_limit='4g', cpus=4,
        healthcheck=dict(test=['CMD', 'python', '/opt/s1/stt_entry.py', '--health'], interval='10s', timeout='5s', retries=12, start_period='120s'))
    result['secrets'] = {'stt_token': {'file': './stt-token'}}
    result['services']['gateway']['ports'] = [dict(target=8000, published='18056', host_ip='127.0.0.1', protocol='tcp')]
    return result


def verify_host(evidence: dict, info: dict, workloads: list) -> None:
    if (evidence.get('dedicated') is not True or evidence.get('private_roles_confirmed') is not True
            or not evidence.get('engine_id') or evidence['engine_id'] != info.get('ID')
            or info.get('OSType') != 'linux' or info.get('Architecture') not in ('amd64', 'x86_64')
            or int(info.get('ServerVersion', '0').split('.')[0]) < 26 or workloads):
        raise ValueError('Confirmed empty dedicated Linux amd64 engine required')


def host_check(root: Path, allow_owned: bool = False) -> None:
    evidence = json.loads((root / 'host-attestation.json').read_text())
    verify_host(evidence, json.loads(docker(['info', '--format', '{{json .}}'])), [])
    ids = docker(['ps', '-aq']).split()
    if ids:
        if not allow_owned:
            raise ValueError('Dedicated engine must be empty before preparation')
        verify_owned(json.loads(docker(['inspect', *ids])))


def build_inputs(lock: dict) -> dict[str, str]:
    python_image, uv_image = [v['tag'].split(':')[0] + '@' + v['digest'] for v in lock['buildImages']]
    if not all(immutable_image(image) for image in (python_image, uv_image)) or not re.fullmatch(r'\d{8}T\d{6}Z', lock['debianSnapshot']):
        raise ValueError('Invalid pinned build inputs')
    recipe = f'''FROM {uv_image} AS uv
FROM {python_image}
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON=/usr/local/bin/python UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/opt/venv PATH=/opt/venv/bin:$PATH PYTHONPATH=/app/src PYTHONDONTWRITEBYTECODE=1
RUN rm -f /etc/apt/sources.list.d/debian.sources && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/{lock['debianSnapshot']} bookworm main\\n' > /etc/apt/sources.list && apt-get update && apt-get install -y --no-install-recommends libgomp1 libsndfile1 ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project
COPY --chown=10001:10001 --chmod=0555 src ./src
COPY --chown=10001:10001 --chmod=0444 stt_entry.py lock.json /opt/s1/
USER 10001:10001
ENTRYPOINT ["python", "/opt/s1/stt_entry.py"]
'''
    return {'Dockerfile': recipe,
            '.dockerignore': '**\n!Dockerfile\n!pyproject.toml\n!uv.lock\n!src/\n!src/**\n!stt_entry.py\n!lock.json\n',
            'stt_entry.py': (HERE / 'stt_entry.py').read_text(), 'lock.json': (HERE / 'lock.json').read_text()}


def prepare_build(root: Path, lock: dict) -> None:
    verify_files(root, lock['sourceFiles'])
    for name, value in build_inputs(lock).items():
        private_write(root / name, value)


def verify_build_inputs(root: Path, lock: dict) -> None:
    verify_files(root, lock['sourceFiles'])
    expected = {f['path'] for f in lock['sourceFiles'] if f['path'].startswith('src/')}
    for file in (root / 'src').rglob('*'):
        if file.is_symlink() or (file.is_file() and file.relative_to(root).as_posix() not in expected):
            raise ValueError('Unexpected source build input')
    for name, value in build_inputs(lock).items():
        file = owned_path(root, name)
        if not file.is_file() or file.read_text() != value:
            raise ValueError('Prepared build input changed')


def prepare_base(root: Path, lock: dict) -> None:
    if (root / '.env').exists() or (root / '.env').is_symlink():
        raise ValueError('Unexpected upstream env_file rejected')
    verify_files(root, [f for f in lock['sourceFiles'] if f['path'] in ('upstream-compose.yml', 'storage_init.py')])
    private_write(root / 'empty.env', '')
    env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP') if key in os.environ}
    env.update(IMAGE_TAG=lock['release'], INTERNAL_API_SECRET='offline-config-only',
               VEXA_FLOWS_API_KEY='offline-config-only', VEXA_FLOWS_TIMELINE_KEY='offline-config-only',
               VEXA_DISPATCH_SIGNING_KEY='offline-config-only')
    result = subprocess.run(['docker', 'compose', '--env-file', 'empty.env', '-f',
                             'upstream-compose.yml', 'config', '--format', 'json'],
                            cwd=root, env=env, text=True, capture_output=True, timeout=30, check=True)
    json.loads(result.stdout)
    private_write(root / 'base-compose.json', result.stdout)
    private_write(root / 'base-receipt.json', json.dumps(dict(sha256=digest(root / 'base-compose.json'))))


def build_stt(root: Path, lock: dict) -> None:
    verify_build_inputs(root, lock)
    host_check(root)
    subprocess.run(['docker', 'build', '--platform', 'linux/amd64', '--network', 'default',
                    '-t', 'mw-s1-stt:local', '.'], cwd=root, capture_output=True,
                   timeout=900, check=True)
    image = json.loads(docker(['image', 'inspect', 'mw-s1-stt:local']))[0]
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image['Id']):
        raise ValueError('Build image identity unavailable')
    private_write(root / 'runtime-receipt.json', json.dumps(dict(
        image_id=image['Id'], lock_sha256=digest(HERE / 'lock.json'),
        dockerfile_sha256=digest(root / 'Dockerfile'), runtime_compatibility='NOT_VERIFIED'), indent=2))


def docker(args: list[str], timeout: int = 30) -> str:
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise ValueError('Private Docker operation failed')
    return result.stdout


def verify_owned(containers: list[dict]) -> None:
    for container in containers:
        labels = container.get('Config', {}).get('Labels', {})
        if labels.get('meetwise.s1') != 'private-offline' or labels.get('com.docker.compose.project') != 'mw-s1':
            raise ValueError('Unowned resource rejected')


def teardown_command() -> list[str]:
    return ['compose', '--env-file', 'private.env', '-f', 'compose.json', '-p', 'mw-s1', 'down', '--timeout', '15']


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['init', 'rotate-stt', 'fetch-source', 'fetch-model', 'verify-model', 'verify-host', 'prepare-build', 'prepare-base', 'build-stt', 'render', 'health-stt', 'teardown'])
    parser.add_argument('private_directory', type=Path)
    args = parser.parse_args()
    root = args.private_directory.absolute()
    try:
        if args.action == 'init':
            if sys.platform != 'linux':
                raise ValueError('Linux private filesystem required for real initialization')
            initialize(root)
        else:
            require_private_root(root)
            lock = json.loads((HERE / 'lock.json').read_text())
            if args.action == 'rotate-stt':
                host_check(root)
                rotate_stt(root)
            elif args.action in ('fetch-model', 'verify-model'):
                model = root / 'model'
                if args.action == 'fetch-model':
                    model.mkdir(exist_ok=True)
                    fetch_files(model, lock['model']['files'])
                verify_files(model, lock['model']['files'])
                prepare_model_permissions(model, lock['model']['files'])
            elif args.action == 'fetch-source':
                fetch_files(root, lock['sourceFiles'])
            elif args.action == 'verify-host':
                host_check(root)
            elif args.action == 'prepare-build':
                prepare_build(root, lock)
            elif args.action == 'prepare-base':
                prepare_base(root, lock)
            elif args.action == 'build-stt':
                build_stt(root, lock)
            elif args.action == 'render':
                verify_build_inputs(root, lock)
                receipt = json.loads((root / 'runtime-receipt.json').read_text())
                if receipt['lock_sha256'] != digest(HERE / 'lock.json'):
                    raise ValueError('Stale build receipt')
                if receipt['dockerfile_sha256'] != digest(root / 'Dockerfile'):
                    raise ValueError('Changed build recipe')
                verify_files(root / 'model', lock['model']['files'])
                lock['sttImage'] = receipt['image_id']
                if json.loads((root / 'base-receipt.json').read_text())['sha256'] != digest(root / 'base-compose.json'):
                    raise ValueError('Changed base configuration')
                base = json.loads((root / 'base-compose.json').read_text())
                private_write(root / 'compose.json', json.dumps(secure_compose(base, lock), indent=2))
                env = read_env(root / 'private.env')
                private_write(root / 'stt-token', env['STT_TOKEN'])
                os.chmod(root / 'stt-token', 0o644)
            elif args.action == 'teardown':
                host_check(root, allow_owned=True)
                ids = docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=mw-s1']).split()
                if ids:
                    verify_owned(json.loads(docker(['inspect', *ids])))
                    subprocess.run(['docker', *teardown_command()], cwd=root, capture_output=True, timeout=90, check=True)
            elif args.action == 'health-stt':
                host_check(root, allow_owned=True)
                ids = docker(['ps', '-q', '--filter', 'label=com.docker.compose.project=mw-s1', '--filter', 'label=com.docker.compose.service=stt']).split()
                if len(ids) != 1:
                    raise ValueError('Exactly one owned STT container required')
                verify_owned(json.loads(docker(['inspect', *ids])))
                docker(['exec', ids[0], 'python', '/opt/s1/stt_entry.py', '--health'], timeout=10)
        print(json.dumps({'status': 'OFFLINE_ACTION_COMPLETED_NOT_S1_GO', 'action': args.action}))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('S1_PREPARATION_FAILED: private details suppressed.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
