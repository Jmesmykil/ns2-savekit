#!/usr/bin/env python3
"""Synthetic offline checks for the exact two-file corrective stage."""
import hashlib
import importlib.util
import json
import subprocess
import struct
import zlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('prepare_editor_slot', ROOT / 'tools/prepare-editor-slot.py')
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='slot3-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.backup = self.root / 'backup'
        self.files = self.backup / 'files'
        self.files.mkdir(parents=True)
        self.editor = self.root / 'editor'
        self.editor.mkdir()
        # Labelled synthetic input, never an installable or personal save.
        self.sources = {name: ('SYNTHETIC ' + name).encode() for name in prep.SOURCE_HASHES}
        for name, data in self.sources.items():
            (self.editor / name).write_bytes(data)
        self.originals = {'/' + name: data for name, data in self.sources.items() if name != 'save0003.dat'}
        script = b'system/first.iet'
        fields = struct.pack('<II', 0, 1) + struct.pack('<I', len(script)) + script + struct.pack('<I', 42)
        groups = {0: {3: 4}, 4: {1: 4, 3: 8, 4: 12 + len(script)}}
        index = struct.pack('<I', len(groups))
        for base, entries in groups.items():
            index += struct.pack('<II', base, len(entries))
            for key, offset in entries.items():
                index += struct.pack('<II', key, offset)
        body = fields + index + struct.pack('<I', len(fields))
        self.native = b'BOWG' + struct.pack('<II', 1003, len(body)) + zlib.compress(body)
        self.originals.update({'/save0003.dat': self.native,
            '/ns2jb.lua': b'synthetic registration', '/save0001.dat': b'personal slot1',
            '/save0001.png': b'personal thumbnail', '/autosave.dat': self.native,
            '/saveg.dat': b'native slot metadata'})
        for name, data in self.originals.items():
            (self.files / name[1:]).write_bytes(data)
        self.manifest = {'complete': True, 'hostIndependentReadbackVerified': True,
            'fixtureOnly': True, 'evidence': {'targetIdentity': {'applicationId': prep.TITLE,
                'userId': '01' * 16, 'saveId': '0000000000000001'}},
            'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data)}
                      for name, data in self.originals.items()]}
        self.path = self.backup / 'manifest.json'
        self.save_manifest()
        # Inject only fixture hashes in this test process. CLI retains pinned real hashes.
        self.pins = patch.object(prep, 'SOURCE_HASHES', {name: digest(data) for name, data in self.sources.items()})
        self.pins.start()
        self.addCleanup(self.pins.stop)
        registration = patch.object(prep, 'REGISTRATION_HASH', digest(b'synthetic registration'))
        registration.start()
        self.addCleanup(registration.stop)

    def save_manifest(self):
        self.path.write_text(json.dumps(self.manifest))

    def build(self):
        return prep.build(self.path, self.editor, self.root / 'stage')

    def update_backup(self, name, data):
        (self.files / name[1:]).write_bytes(data)
        for record in self.manifest['files']:
            if record['path'] == name:
                record.update(bytes=len(data), sha256=digest(data))
                break
        else:
            self.manifest['files'].append({'path': name, 'bytes': len(data), 'sha256': digest(data)})
        self.save_manifest()

    def test_exact_two_replacements_and_originals_unchanged(self):
        result = self.build()
        jobs = {job['path']: job for job in result['files']}
        self.assertEqual(set(jobs), {'/save0003.dat', '/ns2jb.lua'})
        self.assertTrue(all(job['replace'] for job in jobs.values()))
        self.assertEqual(Path(jobs['/save0003.dat']['local']).read_bytes(), self.sources['save0003.dat'])
        self.assertEqual(digest(Path(jobs['/ns2jb.lua']['local']).read_bytes()), prep.RESTORE_HASH)
        self.assertEqual(result['preservedFiles'], len(self.originals) - 2)
        self.assertTrue(result['hostStageOnly'])
        self.assertFalse(result['rebootPersistenceVerified'])
        for name, data in self.originals.items():
            self.assertEqual((self.files / name[1:]).read_bytes(), data)

    def test_wrong_title_rejected_before_output(self):
        self.manifest['evidence']['targetIdentity']['applicationId'] = '0100EE5021C9E000'
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Demo'):
            self.build()
        self.assertFalse((self.root / 'stage').exists())

    def test_zero_uid_rejected(self):
        self.manifest['evidence']['targetIdentity']['userId'] = '00' * 16
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'account UID'):
            self.build()

    def test_incomplete_backup_rejected(self):
        self.manifest['complete'] = False
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Complete'):
            self.build()

    def test_changed_backup_rejected(self):
        (self.files / 'autosave.dat').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            self.build()

    def test_extra_file_rejected(self):
        (self.files / 'extra').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, 'complete manifest'):
            self.build()

    def test_case_alias_rejected(self):
        self.manifest['files'].append({**self.manifest['files'][0], 'path': self.manifest['files'][0]['path'].upper()})
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'case-alias'):
            self.build()

    def test_symlinked_backup_rejected(self):
        path = self.files / 'autosave.dat'
        path.unlink()
        path.symlink_to(self.files / 'save0001.dat')
        with self.assertRaisesRegex(ValueError, 'non-symlink'):
            self.build()

    def test_editor_source_changed_rejected(self):
        (self.editor / 'ssedit3.lua').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'recipe source'):
            self.build()

    def test_editor_prerequisite_missing_rejected(self):
        (self.files / 'sed03.asb').unlink()
        self.manifest['files'] = [row for row in self.manifest['files'] if row['path'] != '/sed03.asb']
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Prerequisite'):
            self.build()

    def test_native_slot_missing_rejected(self):
        (self.files / 'save0003.dat').unlink()
        self.manifest['files'] = [row for row in self.manifest['files'] if row['path'] != '/save0003.dat']
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'normal game save'):
            self.build()

    def test_already_editor_slot_rejected(self):
        self.update_backup('/save0003.dat', self.sources['save0003.dat'])
        with self.assertRaisesRegex(ValueError, 'normal game save'):
            self.build()

    def test_unknown_boot_body_rejected(self):
        self.update_backup('/ns2jb.lua', b'unknown')
        with self.assertRaisesRegex(ValueError, 'boot body'):
            self.build()

    def test_existing_output_preserved(self):
        output = self.root / 'stage'
        output.mkdir()
        (output / 'keep').write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual((output / 'keep').read_bytes(), b'keep')

    def test_output_inside_input_rejected(self):
        with self.assertRaisesRegex(ValueError, 'outside input'):
            prep.build(self.path, self.editor, self.backup / 'stage')

    def test_output_parent_traversal_rejected(self):
        with self.assertRaisesRegex(ValueError, 'parent traversal'):
            prep.build(self.path, self.editor, self.root / 'editor/../stage')

    def test_cli_help_outside_checkout(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tools/prepare-editor-slot.py'), '--help'],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--backup-manifest', result.stdout)

    def test_cli_refuses_unpinned_synthetic_sources(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tools/prepare-editor-slot.py'),
            '--backup-manifest', str(self.path), '--editor-dir', str(self.editor),
            '--output', str(self.root / 'stage')], cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('recipe source differs', result.stderr)
        self.assertFalse((self.root / 'stage').exists())

    def test_corrupt_native_container_rejected(self):
        self.update_backup('/save0003.dat', b'BOWG')
        with self.assertRaisesRegex(ValueError, 'structurally valid'):
            self.build()

    def test_prerequisite_stage_is_eight_adds_one_guarded_replace(self):
        for name in list(self.originals):
            if name == '/save0003.dat' or name[1:] in self.sources:
                (self.files / name[1:]).unlink()
                self.manifest['files'] = [row for row in self.manifest['files'] if row['path'] != name]
        self.update_backup('/ns2jb.lua', (ROOT / 'payloads/restore-launch-marker.lua').read_bytes())
        with patch.object(prep, 'REGISTRATION_HASH', digest((ROOT / 'payloads/register-editor-slot3.lua').read_bytes())):
            result = prep.build(self.path, self.editor, self.root / 'stage', 'prerequisites')
        self.assertEqual(len(result['files']), 9)
        self.assertEqual([row['path'] for row in result['files'] if row.get('replace')], ['/ns2jb.lua'])
        self.assertEqual(result['phase'], 'prerequisites')

    def test_prerequisite_existing_slot_refused(self):
        self.update_backup('/ns2jb.lua', (ROOT / 'payloads/restore-launch-marker.lua').read_bytes())
        with self.assertRaisesRegex(ValueError, 'add-only'):
            prep.build(self.path, self.editor, self.root / 'stage', 'prerequisites')

    def test_baseline_is_exact_four_files_and_preserves_gameplay(self):
        result = prep.build(self.path, None, self.root / 'stage', 'baseline')
        jobs = {entry['path']: entry for entry in result['files']}
        self.assertEqual(set(jobs), {'/ns2jb.asb', '/save9999.dat', '/ns2jb.lua', '/sscode004.lua'})
        self.assertNotIn('/autosave.dat', jobs)
        self.assertNotIn('/save0001.dat', jobs)
        self.assertEqual((self.files / 'autosave.dat').read_bytes(), self.native)
        self.assertEqual(digest(Path(jobs['/ns2jb.asb']['local']).read_bytes()),
            'f800caa253ec0c3a7a441550a1522c0edf21fc8c5861d366a3f594bf13619216')

    def test_baseline_disable_marker_preserved(self):
        self.update_backup('/ns2jb-off.txt', b'')
        with self.assertRaisesRegex(ValueError, 'disable marker'):
            prep.build(self.path, None, self.root / 'stage', 'baseline')


if __name__ == '__main__':
    unittest.main(verbosity=2)
