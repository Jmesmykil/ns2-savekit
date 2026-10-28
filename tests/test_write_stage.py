#!/usr/bin/env python3
"""Bound write validation and fake-process readback checks; no console connection."""
import hashlib
import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('write_stage', ROOT / 'tools/write-prepared-stage.py')
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save_fixture():
    script = b'system/first.iet'
    fields = struct.pack('<II', 0, 1) + struct.pack('<I', len(script)) + script + struct.pack('<I', 42)
    groups = {0: {3: 4}, 4: {1: 4, 3: 8, 4: 12 + len(script)}}
    index = struct.pack('<I', len(groups))
    for base, entries in groups.items():
        index += struct.pack('<II', base, len(entries))
        for key, offset in entries.items():
            index += struct.pack('<II', key, offset)
    body = fields + index + struct.pack('<I', len(fields))
    return b'BOWG' + struct.pack('<II', 1003, len(body)) + zlib.compress(body)


class WriteStageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='write-stage-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.run = self.root / 'run'
        (self.run / 'switch2/ro/root').mkdir(parents=True)
        (self.run / 'switch2/current-acquisition.json').write_text(json.dumps({'session': 'fixture'}))
        (self.run / 'switch2/ro/root/current-root.json').write_text(json.dumps({'session': 'fixture', 'pid': 1, 'rootHandle': 7}))
        self.transaction = {'runDirectory': str(self.run), 'session': 'fixture', 'id': 'fixture-transaction'}
        (self.run / '.savekit-backup-reserved.json').write_text(json.dumps(self.transaction))
        self.backup = self.root / 'backup'
        (self.backup / 'files').mkdir(parents=True)
        self.originals = {'/autosave.dat': save_fixture(), '/keep.txt': b'own file'}
        for name, data in self.originals.items():
            (self.backup / 'files' / name[1:]).write_bytes(data)
        manifest = {'complete': True, 'hostIndependentReadbackVerified': True,
            'evidence': {'targetIdentity': {'applicationId': writer.prep.TITLE, 'userId': '01' * 16},
                'runDirectory': str(self.run), 'session': 'fixture', 'transaction': 'fixture-transaction',
                'deviceProvenanceAuthenticated': False, 'pullReceipt': str(self.backup / 'pull-result.json')},
            'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data)} for name, data in self.originals.items()]}
        self.backup_manifest = self.backup / 'manifest.json'
        self.backup_manifest.write_text(json.dumps(manifest))
        receipt = {'complete': True, 'returncode': 0, 'sourceSHA256': writer.backup_tool.PULL_HASH,
            'manifestSHA256': digest(self.backup_manifest.read_bytes()), 'runDirectory': str(self.run),
            'session': 'fixture', 'transaction': 'fixture-transaction'}
        (self.backup / 'pull-result.json').write_text(json.dumps(receipt))
        stage = writer.prep.build(self.backup_manifest, None, self.root / 'stage', 'baseline')
        self.manifest = self.root / 'stage/manifest.json'
        self.staged = {job['path']: Path(job['local']).read_bytes() for job in stage['files']}
        self.writer_path = self.root / 'save-write-stage.cjs'
        self.writer_path.write_bytes(subprocess.run(['git', 'show', '856b6c4145bd2075815527327b120186017afca3:tools/save-write-stage.cjs'], cwd=ROOT, capture_output=True, check=True).stdout)

    def validate(self):
        return writer.validate(self.run, self.writer_path, self.manifest)

    def lines(self):
        lines = ['commit -> 0x0']
        for name, data in {**self.originals, **self.staged}.items():
            tag = '(written ok) ' if name in self.staged else ''
            status = 'n/a' if name in self.staged else 'ok'
            lines.append('  %s %d %s  %s%s' % (name[1:], len(data), digest(data)[:16], tag, status))
        return lines

    def test_valid_bound_stage(self):
        self.assertEqual(self.validate()[3]['phase'], 'baseline')

    def test_changed_stage_bytes_refused(self):
        (self.manifest.parent / 'files/ns2jb.lua').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'size/hash'):
            self.validate()

    def test_different_run_refused(self):
        another = self.root / 'other'
        (another / 'switch2/ro/root').mkdir(parents=True)
        for name in ('switch2/current-acquisition.json', 'switch2/ro/root/current-root.json'):
            (another / name).write_bytes((self.run / name).read_bytes())
        with self.assertRaisesRegex(ValueError, 'different run/session'):
            writer.validate(another, self.writer_path, self.manifest)

    def test_stale_current_session_refused(self):
        (self.run / 'switch2/current-acquisition.json').write_text(json.dumps({'session': 'new'}))
        with self.assertRaisesRegex(ValueError, 'root identity'):
            self.validate()

    def test_changed_backup_manifest_refused(self):
        self.backup_manifest.write_text(self.backup_manifest.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'manifest hash'):
            self.validate()

    def test_unknown_writer_refused(self):
        self.writer_path.write_bytes(b'unknown')
        with self.assertRaisesRegex(ValueError, 'pinned'):
            self.validate()

    def test_complete_readback_accepted(self):
        result = writer.check_readback('\n'.join(self.lines()), self.originals, self.staged)
        self.assertEqual(result, {'writtenFiles': 4, 'preservedFiles': 2})

    def test_missing_commit_refused(self):
        with self.assertRaisesRegex(ValueError, 'commit'):
            writer.check_readback('\n'.join(self.lines()[1:]), self.originals, self.staged)

    def test_missing_duplicate_and_extra_rows_refused(self):
        lines = self.lines()
        variants = [lines[:-1], lines + [lines[-1]], lines + ['  unknown 0 e3b0c44298fc1c14  n/a']]
        for variant in variants:
            with self.assertRaises(ValueError):
                writer.check_readback('\n'.join(variant), self.originals, self.staged)

    def test_write_mismatch_and_changed_original_refused(self):
        for text in ('\n'.join(self.lines()).replace('(written ok)', '(WRITE MISMATCH)', 1),
                     '\n'.join(self.lines()).replace('  ok', '  DIFFERS', 1)):
            with self.assertRaises(ValueError):
                writer.check_readback(text, self.originals, self.staged)

    def test_writer_rechecks_baseline_preconditions(self):
        marker = self.backup / 'files/ns2jb-off.txt'
        marker.write_bytes(b'')
        backup = json.loads(self.backup_manifest.read_text())
        backup['files'].append({'path': '/ns2jb-off.txt', 'bytes': 0, 'sha256': digest(b'')})
        self.backup_manifest.write_text(json.dumps(backup))
        receipt_file = self.backup / 'pull-result.json'
        receipt = json.loads(receipt_file.read_text())
        receipt['manifestSHA256'] = digest(self.backup_manifest.read_bytes())
        receipt_file.write_text(json.dumps(receipt))
        stage = json.loads(self.manifest.read_text())
        stage['backupManifestSHA256'] = digest(self.backup_manifest.read_bytes())
        self.manifest.write_text(json.dumps(stage))
        with self.assertRaisesRegex(ValueError, 'disable marker'):
            self.validate()

    def test_non_file_readback_entry_refused(self):
        text = '\n'.join(self.lines() + ['  unknown-dir    <not a file: 0x202>'])
        with self.assertRaisesRegex(ValueError, 'non-file'):
            writer.check_readback(text, self.originals, self.staged)

    def test_fake_node_cli_success_and_no_replay(self):
        bindir = self.root / 'bin'
        bindir.mkdir()
        node = bindir / 'node'
        node.write_text('#!' + sys.executable + '\nimport json,os\nlines=json.loads(os.environ["FAKE_WRITER_LINES"])\nprint("\\n".join(lines))\n')
        node.chmod(0o700)
        env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ['PATH'], FAKE_WRITER_LINES=json.dumps(self.lines()))
        cmd = [sys.executable, str(ROOT / 'tools/write-prepared-stage.py'), '--run', str(self.run),
            '--writer', str(self.writer_path), '--manifest', str(self.manifest)]
        result = subprocess.run(cmd, cwd=self.root, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.manifest.parent / 'write-result.json').read_text())
        self.assertTrue(receipt['complete'])
        result = subprocess.run(cmd, cwd=self.root, env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(json.loads((self.manifest.parent / 'write-result.json').read_text())['complete'])

    def test_zero_exit_with_partial_readback_refused(self):
        bindir = self.root / 'bin'
        bindir.mkdir()
        node = bindir / 'node'
        node.write_text('#!' + sys.executable + '\nprint("commit -> 0x0")\n')
        node.chmod(0o700)
        env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ['PATH'])
        cmd = [sys.executable, str(ROOT / 'tools/write-prepared-stage.py'), '--run', str(self.run),
            '--writer', str(self.writer_path), '--manifest', str(self.manifest)]
        result = subprocess.run(cmd, cwd=self.root, env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads((self.manifest.parent / 'write-result.json').read_text())['complete'])
        self.assertTrue((self.run / '.savekit-write-reserved.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
