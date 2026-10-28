"""Offline route preparation, SSH trust, source pins and ownership controls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ROUTE = ROOT / 'tools/established-route'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load('prepare_established_route', ROUTE / 'prepare.py')


class RoutePreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='savekit-route-test-')
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name).resolve()
        self.config = json.loads((ROUTE / 'config.example.json').read_text())
        ssh = self.folder / 'ssh-config'
        ssh.write_text('Host configured-keyboard-host\n StrictHostKeyChecking yes\n HostKeyAlias configured-keyboard-key\n')
        self.config['sshConfig'] = str(ssh)
        self.file = self.folder / 'config.json'
        self.write_config()

    def write_config(self):
        self.file.write_text(json.dumps(self.config))

    def test_public_configuration_requires_explicit_values(self):
        result = prepare.configuration(self.file)
        self.assertEqual(result, self.config)
        del self.config['usbSerial']
        self.write_config()
        with self.assertRaisesRegex(ValueError, 'Config keys'):
            prepare.configuration(self.file)

    def test_endpoint_and_ssh_argument_injection_refused(self):
        for key, value in [('host', '127.0.0.1'), ('host', '::1'), ('port', True),
                           ('sshAlias', '-Fother'), ('piHostname', 'host;command'),
                           ('usbSerial', "serial'\ncode")]:
            with self.subTest(key=key, value=value):
                old = self.config[key]
                self.config[key] = value
                self.write_config()
                with self.assertRaises((ValueError, TypeError)):
                    prepare.configuration(self.file)
                self.config[key] = old

    def test_integer_host_refused_before_output_creation(self):
        self.config['host'] = 3221225985
        self.write_config()
        output = self.folder / 'package'
        result = subprocess.run([sys.executable, str(ROUTE / 'prepare.py'),
            '--ns2jb', str(self.folder), '--keyboard-source', str(self.file),
            '--config', str(self.file), '--output', str(output)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('IPv4 string', result.stderr)
        self.assertFalse(output.exists())

    def test_engine_manifest_excludes_broader_pipeline_and_runtime(self):
        pins = json.loads((ROUTE / 'engine-pins.json').read_text())
        names = [record['path'] for record in pins['files']]
        self.assertEqual(len(names), 90)
        self.assertEqual(len(set(names)), 90)
        for name in ('switch2/pipeline.cjs', 'switch2/cleanup-scratch.cjs',
                     'switch2/firmware-dump.cjs', 'connection.json'):
            self.assertNotIn(name, names)
        self.assertIn('switch2/acquire.cjs', names)

    def test_wrong_external_source_refused_before_output_creation(self):
        output = self.folder / 'package'
        result = subprocess.run([sys.executable, str(ROUTE / 'prepare.py'),
                                 '--ns2jb', str(self.folder), '--config', str(self.file),
                                 '--keyboard-source', str(self.file), '--output', str(output)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def test_historical_save_tools_recover_exact_public_history(self):
        for name, digest in prepare.SAVE_TOOLS.items():
            with self.subTest(name=name):
                data = subprocess.check_output(['git', '-C', str(ROOT), 'show',
                                                prepare.SAVEKIT_REVISION + ':tools/' + name])
                self.assertEqual(hashlib.sha256(data).hexdigest(), digest)

    def test_ssh_cli_forces_trust_even_with_misleading_config_comments(self):
        core = self.folder / 'core'
        core.mkdir()
        for file in (ROUTE / 'templates/core').iterdir():
            if file.is_file():
                (core / file.name).write_text(prepare.render(file.read_text(), self.config))
        Path(self.config['sshConfig']).write_text(
            '# StrictHostKeyChecking yes\n# HostKeyAlias configured-keyboard-key\n'
            'Host configured-keyboard-host\n StrictHostKeyChecking no\n')
        phase = load('route_phase_ssh_fixture', core / 'phase.py')
        seen = []

        def fake_run(argv, **kwargs):
            seen.append((argv, kwargs))
            return types.SimpleNamespace(returncode=0, stdout='{}')

        result = phase.remote_call('keyboard.local', 'remote-preflight.py',
                                   {'action': 'preflight'}, run=fake_run)
        self.assertEqual(result['returncode'], 0)
        argv = seen[0][0]
        self.assertIn('StrictHostKeyChecking=yes', argv)
        self.assertIn('HostKeyAlias=configured-keyboard-key', argv)
        self.assertEqual(argv[argv.index('HostKeyAlias=configured-keyboard-key') + 1],
                         self.config['sshAlias'])

    def control_module(self, replies):
        fake = types.ModuleType('phase')
        calls = []
        fake.load_launch = lambda attempt: {'fixture': str(attempt)}

        def control(_launch, command='status'):
            calls.append(command)
            return replies.pop(0)

        fake.live_control = control
        with patch.dict(sys.modules, {'phase': fake}):
            module = load('route_control_fixture', ROUTE / 'templates/control.py')
        return module, calls

    def test_release_waits_for_owned_idle_then_returns(self):
        module, calls = self.control_module([
            {'state': 'FS_ROOT_READY', 'busy': False}, {'result': {'reserved': True}},
            {'state': 'FS_RELEASING', 'busy': True},
            {'state': 'QUALIFIED', 'filesystemOwnership': False, 'busy': False}])
        with patch.object(module.time, 'sleep'):
            result = module.control(self.folder, 'release-fs')
        self.assertEqual(result['state'], 'QUALIFIED')
        self.assertEqual(calls, ['status', 'release-fs', 'status', 'status'])

    def test_stop_refused_before_filesystem_release(self):
        module, calls = self.control_module([{'state': 'FS_ROOT_READY', 'busy': False}])
        with self.assertRaisesRegex(ValueError, 'Release known filesystem'):
            module.control(self.folder, 'stop')
        self.assertEqual(calls, ['status'])

    def test_uncertain_release_never_retries_or_reports_closed(self):
        module, calls = self.control_module([
            {'state': 'FS_ROOT_READY', 'busy': False}, {'result': {'reserved': True}},
            {'state': 'TERMINAL_UNCERTAIN', 'terminal': True}])
        with self.assertRaisesRegex(ValueError, 'uncertain'):
            module.control(self.folder, 'release-fs')
        self.assertEqual(calls, ['status', 'release-fs', 'status'])

    def test_checked_normal_stop_requires_closed_reply(self):
        module, calls = self.control_module([
            {'state': 'QUALIFIED', 'filesystemOwnership': False, 'busy': False},
            {'state': 'CLOSED', 'result': {'closed': True}}])
        result = module.control(self.folder, 'stop')
        self.assertEqual(result['state'], 'CLOSED')
        self.assertEqual(calls, ['status', 'stop'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
