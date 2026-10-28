#!/usr/bin/env python3
"""Exercise backup wrapper with a controlled fake node process, never a console."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class RecordBackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='backup-wrapper-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.run = self.root / 'run'
        (self.run / 'switch2/ro/root').mkdir(parents=True)
        (self.run / 'switch2/current-acquisition.json').write_text(json.dumps({'session': 'fixture'}))
        (self.run / 'switch2/ro/root/current-root.json').write_text(json.dumps({'session': 'fixture', 'pid': 1, 'rootHandle': 10}))
        self.pull_tool = self.root / 'save-pull-root.cjs'
        self.pull_tool.write_bytes(subprocess.run(['git', 'show', '856b6c4145bd2075815527327b120186017afca3:tools/save-pull-root.cjs'], cwd=ROOT, check=True, capture_output=True).stdout)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        node = self.bin / 'node'
        node.write_text('#!' + sys.executable + "\n" + """import os, sys
from pathlib import Path
files = Path(sys.argv[4])
uid = sys.argv[5]
(files / 'autosave.dat').write_bytes(b'fixture')
(files / 'empty.txt').write_bytes(b'')
mode = os.environ.get('FAKE_PULL_MODE', 'ok')
print('  space=User type=Account uid=' + uid[:16].lower() + ' -> ok')
print('mounted space=User type=Account uid=' + uid.lower())
print('  /autosave.dat (7 bytes)')
print('  /empty.txt (0 bytes)')
if mode != 'missing-summary':
    print('done: 2 files, ' + ('8' if mode == 'bad-total' else '7') + ' bytes -> ' + str(files))
if mode == 'extra': (files / 'unlisted').write_bytes(b'unlisted')
if mode == 'fail': sys.exit(3)
""")
        node.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'])
        self.command = [sys.executable, str(ROOT / 'tools/record-save-backup.py'),
            '--pull-tool', str(self.pull_tool), '--run', str(self.run), '--uid', '01' * 16,
            '--save-id', '0000000000000001', '--output', str(self.root / 'backup')]

    def execute(self, mode='ok'):
        return subprocess.run(self.command, env=dict(self.env, FAKE_PULL_MODE=mode),
                              cwd=self.root, capture_output=True, text=True)

    def test_success_records_inventory_but_no_device_authentication(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / 'backup/manifest.json').read_text())
        self.assertTrue(manifest['complete'])
        self.assertFalse(manifest['evidence']['deviceProvenanceAuthenticated'])
        self.assertEqual([row['bytes'] for row in manifest['files']], [7, 0])
        receipt = json.loads((self.root / 'backup/pull-result.json').read_text())
        self.assertTrue(receipt['complete'])
        self.assertFalse(receipt['retryPerformed'])
        self.assertEqual(receipt['saveIdSource'], 'caller-supplied')

    def test_failed_pull_preserves_log_without_complete_manifest(self):
        result = self.execute('fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'backup/manifest.json').exists())
        self.assertTrue((self.root / 'backup/pull.log').exists())
        receipt = json.loads((self.root / 'backup/pull-result.json').read_text())
        self.assertEqual(receipt['returncode'], 3)
        self.assertFalse(receipt['complete'])

    def test_missing_completion_refused(self):
        result = self.execute('missing-summary')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'backup/manifest.json').exists())

    def test_wrong_totals_refused(self):
        result = self.execute('bad-total')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'backup/manifest.json').exists())

    def test_unlisted_file_refused(self):
        result = self.execute('extra')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'backup/manifest.json').exists())
        receipt = json.loads((self.root / 'backup/pull-result.json').read_text())
        self.assertFalse(receipt['complete'])

    def test_existing_output_preserved(self):
        output = self.root / 'backup'
        output.mkdir()
        (output / 'keep').write_bytes(b'keep')
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((output / 'keep').read_bytes(), b'keep')
        self.assertFalse((output / 'pull.log').exists())

    def test_repeated_pull_same_run_refused(self):
        self.assertEqual(self.execute().returncode, 0)
        self.command[-1] = str(self.root / 'second-backup')
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'second-backup/pull.log').exists())

    def test_stale_root_session_refused_before_pull(self):
        (self.run / 'switch2/ro/root/current-root.json').write_text(json.dumps({'session': 'stale', 'pid': 1, 'rootHandle': 10}))
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'backup').exists())

    def test_missing_descriptive_save_id_supported(self):
        at = self.command.index('--save-id')
        del self.command[at:at+2]
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / 'backup/manifest.json').read_text())
        self.assertIsNone(manifest['evidence']['targetIdentity']['saveId'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
