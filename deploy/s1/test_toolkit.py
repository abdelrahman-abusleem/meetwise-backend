"""Offline synthetic tests. Never starts Docker or downloads weights."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import toolkit
import stt_entry


def synthetic_lock():
    pin = 'sha256:' + 'a' * 64
    return dict(images={'vexaai/' + name: 'vexaai/' + name + '@' + pin for name in toolkit.SERVICES} | {'vexaai/vexa-bot': 'vexaai/vexa-bot@' + pin}, dependencies=[], sttImage=pin)


def synthetic_base():
    services = {name: dict(image='vexaai/' + name + ':dev', build={}, ports=[], environment={}, volumes=[]) for name in toolkit.SERVICES}
    services['runtime']['volumes'] = [dict(type='bind', source='/var/run/docker.sock', target='/var/run/docker.sock')]
    services['meeting-api']['environment'] = dict(DB_PASSWORD='unsafe', RECORDING_ENABLED='true')
    return {'services': services}


class ToolkitTests(unittest.TestCase):
    def test_owned_destination_must_be_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'private'
            toolkit.initialize(target)
            before = (target / 'private.env').read_bytes()
            with self.assertRaises(ValueError):
                toolkit.initialize(target)
            self.assertEqual((target / 'private.env').read_bytes(), before)

    def test_random_secrets_no_credentials_in_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            one, two = Path(directory) / 'one', Path(directory) / 'two'
            toolkit.initialize(one)
            toolkit.initialize(two)
            self.assertNotEqual((one / 'private.env').read_bytes(), (two / 'private.env').read_bytes())
            secrets = toolkit.read_env(one / 'private.env')
            self.assertGreaterEqual(len(secrets['STT_TOKEN']), 64)
            self.assertNotIn(secrets['STT_TOKEN'], json.dumps(toolkit.attestation_template()))

    def test_env_parser_rejects_duplicate_and_unexpected_values(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'env'
            for text in ['A=x\nA=y', 'A=$(bad)', 'not valid', 'A=x\rB=y']:
                target.write_text(text)
                with self.assertRaises(ValueError):
                    toolkit.read_env(target)

    def test_stt_rotation_preserves_database_and_keeps_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'private'
            toolkit.initialize(root)
            before = toolkit.read_env(root / 'private.env')
            toolkit.rotate_stt(root)
            after = toolkit.read_env(root / 'private.env')
            self.assertNotEqual(before['STT_TOKEN'], after['STT_TOKEN'])
            self.assertEqual(before['DB_PASSWORD'], after['DB_PASSWORD'])
            self.assertTrue(list(root.glob('private.env.backup-*')))

    def test_offline_compose_has_no_optional_agents_or_public_ports(self):
        result = toolkit.secure_compose(synthetic_base(), synthetic_lock())
        self.assertEqual(set(result['services']), set(toolkit.SERVICES) | {'stt'})
        self.assertTrue(all(n['internal'] for n in result['networks'].values()))
        for name, service in result['services'].items():
            self.assertNotIn('build', service)
            self.assertEqual(service['logging'], {'driver': 'none'})
            self.assertEqual(service['labels']['meetwise.s1'], 'private-offline')
            self.assertTrue(all(p['host_ip'] == '127.0.0.1' for p in service.get('ports', [])))
            if name != 'gateway':
                self.assertNotIn('ports', service)

    def test_recording_and_transcription_default_disabled(self):
        env = toolkit.secure_compose(synthetic_base(), synthetic_lock())['services']['meeting-api']['environment']
        self.assertEqual(env['RECORDING_ENABLED'], 'false')
        self.assertEqual(env['TRANSCRIBE_ENABLED'], 'false')
        self.assertEqual(env['TRANSCRIPTION_SERVICE_URL'], 'http://stt:8000')

    def test_model_is_readonly_exact_selected_directory(self):
        stt = toolkit.secure_compose(synthetic_base(), synthetic_lock())['services']['stt']
        self.assertEqual(stt['environment']['MODEL_SIZE'], '/models/small')
        self.assertEqual(stt['environment']['HF_HUB_OFFLINE'], '1')
        self.assertTrue(stt['read_only'])
        self.assertIn('no-new-privileges:true', stt['security_opt'])
        self.assertEqual(stt['cap_drop'], ['ALL'])
        self.assertTrue(stt['volumes'][0]['read_only'])

    def test_unknown_host_mount_rejected(self):
        base = synthetic_base()
        base['services']['runtime']['volumes'].append({'type': 'bind', 'source': '/private/customer', 'target': '/steal'})
        with self.assertRaises(ValueError):
            toolkit.secure_compose(base, synthetic_lock())

    def test_mutable_stt_image_or_dependency_rejected(self):
        lock = synthetic_lock()
        lock['sttImage'] = 'local/stt:dev'
        with self.assertRaises(ValueError):
            toolkit.secure_compose(synthetic_base(), lock)

    def test_artifact_tamper_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_bytes(b'synthetic')
            entry = {'name': 'config.json', 'size': 9, 'sha256': hashlib.sha256(b'synthetic').hexdigest()}
            toolkit.verify_files(root, [entry])
            (root / 'config.json').write_bytes(b'tampered!')
            with self.assertRaises(ValueError):
                toolkit.verify_files(root, [entry])

    def test_bad_download_removes_only_owned_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'sentinel').write_text('preserve')
            response = io.BytesIO(b'bad')
            response.url = 'https://huggingface.co/public'
            item = dict(name='model.bin', url='https://huggingface.co/public', size=4, sha256=hashlib.sha256(b'good').hexdigest())
            with patch.object(toolkit.urllib.request, 'urlopen', return_value=response):
                with self.assertRaises(ValueError):
                    toolkit.fetch_files(root, [item])
            self.assertEqual([p.name for p in root.iterdir()], ['sentinel'])

    def test_path_escape_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['../escape', '/absolute', 'a/../../b']:
                with self.assertRaises(ValueError):
                    toolkit.owned_path(root, name)

    def test_missing_or_shared_engine_attestation_rejected(self):
        for evidence in [{}, toolkit.attestation_template(), dict(toolkit.attestation_template(), dedicated=True)]:
            with self.assertRaises(ValueError):
                toolkit.verify_host(evidence, {'ID': 'engine-test', 'OSType': 'linux', 'Architecture': 'x86_64', 'ServerVersion': '29.8.2'}, [])

    def test_host_requires_exact_engine_and_no_existing_workloads(self):
        evidence = dict(toolkit.attestation_template(), dedicated=True, engine_id='engine-test', private_roles_confirmed=True)
        info = {'ID': 'engine-test', 'OSType': 'linux', 'Architecture': 'x86_64', 'ServerVersion': '29.8.2'}
        toolkit.verify_host(evidence, info, [])
        for changed, workloads in [(dict(info, ID='different'), []), (info, ['existing'])]:
            with self.assertRaises(ValueError):
                toolkit.verify_host(evidence, changed, workloads)

    def test_stt_boot_rejects_empty_token_before_model_load(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'token'
            token.write_text('')
            with self.assertRaises(ValueError):
                stt_entry.validate_runtime(secret=token)

    def test_stt_boot_checks_model_hash_and_forces_local_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(toolkit.os.environ):
            root = Path(directory)
            (root / 'model.bin').write_bytes(b'weights-fixture')
            (root / 'token').write_text('a' * 64)
            (root / 'lock.json').write_text(json.dumps({'model': {'files': [dict(name='model.bin', size=15, sha256=hashlib.sha256(b'weights-fixture').hexdigest())]}}))
            stt_entry.validate_runtime(root, root / 'token', root / 'lock.json')
            self.assertEqual(toolkit.os.environ['MODEL_SIZE'], str(root))
            self.assertEqual(toolkit.os.environ['HF_HUB_OFFLINE'], '1')
            (root / 'model.bin').write_bytes(b'tamper-fixture!!')
            with self.assertRaises(ValueError):
                stt_entry.validate_runtime(root, root / 'token', root / 'lock.json')

    def test_storage_init_file_mount_and_dev_null_are_narrowly_allowed(self):
        base = synthetic_base()
        base['services']['runtime']['volumes'].append(dict(type='bind', source='/dev/null', target='/var/lib/vexa/host-claude-credentials'))
        base['services']['storage-init']['volumes'] = [dict(type='bind', source='/known/source', target='/vexa-storage-tools')]
        result = toolkit.secure_compose(base, synthetic_lock())
        self.assertEqual(result['services']['storage-init']['volumes'][0]['target'], '/vexa-storage-tools/storage_init.py')

    def test_secret_rotation_updates_rendered_stt_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'private'
            toolkit.initialize(root)
            (root / 'stt-token').write_text('old')
            toolkit.rotate_stt(root)
            self.assertEqual((root / 'stt-token').read_text(), toolkit.read_env(root / 'private.env')['STT_TOKEN'])

    def test_image_digest_may_include_upstream_tag(self):
        self.assertTrue(toolkit.immutable_image('versity/versitygw:v1.8.0@sha256:' + 'b' * 64))

    def test_all_prepared_build_inputs_bound_before_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            templates = root / 'templates'
            templates.mkdir()
            (templates / 'stt_entry.py').write_text('canonical-wrapper')
            (templates / 'lock.json').write_text('{}')
            lock = dict(buildImages=[dict(tag='python:version', digest='sha256:' + 'a' * 64), dict(tag='ghcr.io/astral-sh/uv:version', digest='sha256:' + 'b' * 64)], debianSnapshot='20261020T000000Z', sourceFiles=[])
            with patch.object(toolkit, 'HERE', templates), patch.object(toolkit, 'host_check') as host:
                toolkit.prepare_build(root, lock)
                for name, content in toolkit.build_inputs(lock).items():
                    (root / name).write_text('tampered-input')
                    with self.assertRaises(ValueError):
                        toolkit.build_stt(root, lock)
                    host.assert_not_called()
                    (root / name).write_text(content)
                self.assertEqual((root / '.dockerignore').read_text().splitlines()[0], '**')
                self.assertNotIn('!private.env', (root / '.dockerignore').read_text())
                self.assertIn('--chmod=0444 stt_entry.py lock.json', (root / 'Dockerfile').read_text())
                (root / 'src').mkdir()
                (root / 'src' / 'numpy.py').write_text('unexpected-shadow')
                with self.assertRaises(ValueError):
                    toolkit.build_stt(root, lock)
                host.assert_not_called()

    def test_stray_env_rejected_before_compose(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('PROVIDER_SECRET=must-not-import')
            with patch.object(toolkit.subprocess, 'run') as process:
                with self.assertRaises(ValueError):
                    toolkit.prepare_base(root, {})
                process.assert_not_called()

    def test_model_permissions_are_scoped_and_unexpected_files_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            model = private / 'model'
            model.mkdir()
            (model / 'model.bin').write_bytes(b'x')
            entries = [dict(name='model.bin', size=1, sha256=hashlib.sha256(b'x').hexdigest())]
            with patch.object(toolkit.os, 'chmod') as chmod:
                toolkit.prepare_model_permissions(model, entries)
                self.assertEqual(chmod.call_args_list[0].args, (model / 'model.bin', 0o644))
                self.assertEqual(chmod.call_args_list[1].args, (model, 0o755))
                self.assertNotIn(private, [c.args[0] for c in chmod.call_args_list])
            (model / 'unexpected').write_text('must-not-expose')
            with self.assertRaises(ValueError):
                toolkit.prepare_model_permissions(model, entries)

    def test_init_inside_git_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / '.git').mkdir()
            with self.assertRaises(ValueError):
                toolkit.initialize(repo / 'private')

    def test_normalization_subprocess_gets_no_ambient_provider_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(toolkit, 'verify_files'), patch.dict(toolkit.os.environ, {'PROVIDER_SECRET': 'private'}), patch.object(toolkit.subprocess, 'run', return_value=SimpleNamespace(stdout='{}')) as process:
                toolkit.prepare_base(root, {'sourceFiles': [], 'release': 'v0.12.28'})
                options = process.call_args.kwargs
                self.assertNotIn('PROVIDER_SECRET', options['env'])
                self.assertIn('--env-file', process.call_args.args[0])
                self.assertTrue(options['capture_output'])

    def test_private_root_owner_permissions_and_symlinks(self):
        root = Path('synthetic-private')
        with patch.object(toolkit.sys, 'platform', 'linux'), patch.object(Path, 'is_dir', return_value=True), patch.object(Path, 'is_symlink', return_value=False), patch.object(toolkit.os, 'getuid', return_value=1000, create=True), patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=1000, st_mode=0o40700)):
            toolkit.require_private_root(root)
            with patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=1000, st_mode=0o40755)):
                with self.assertRaises(ValueError):
                    toolkit.require_private_root(root)
            with patch.object(Path, 'is_symlink', return_value=True):
                with self.assertRaises(ValueError):
                    toolkit.require_private_root(root)

    def test_wrong_engine_blocks_exec_down_and_rotation_without_secret_output(self):
        for action in ('health-stt', 'teardown', 'rotate-stt'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'lock.json').write_text('{}')
                (root / 'host-attestation.json').write_text(json.dumps(dict(toolkit.attestation_template(), dedicated=True, private_roles_confirmed=True, engine_id='expected')))
                error = io.StringIO()
                with patch.object(toolkit, 'HERE', root), patch.object(toolkit, 'require_private_root'), patch.object(toolkit.sys, 'argv', ['toolkit', action, str(root)]), patch.object(toolkit, 'docker', return_value=json.dumps(dict(ID='different', OSType='linux', Architecture='amd64', ServerVersion='29.8.2'))) as docker, contextlib.redirect_stderr(error):
                    self.assertEqual(toolkit.main(), 2)
                    self.assertEqual(len(docker.call_args_list), 1)
                    self.assertEqual(docker.call_args.args[0][0], 'info')
                self.assertEqual(error.getvalue(), 'S1_PREPARATION_FAILED: private details suppressed.\n')
                self.assertNotIn(directory, error.getvalue())

    def test_teardown_refuses_foreign_resources_and_preserves_volumes(self):
        toolkit.verify_owned([{'Config': {'Labels': {'meetwise.s1': 'private-offline', 'com.docker.compose.project': 'mw-s1'}}}])
        with self.assertRaises(ValueError):
            toolkit.verify_owned([{'Config': {'Labels': {'meetwise.s1': 'other'}}}])
        self.assertNotIn('-v', toolkit.teardown_command())
        self.assertNotIn('prune', toolkit.teardown_command())


if __name__ == '__main__':
    unittest.main()
