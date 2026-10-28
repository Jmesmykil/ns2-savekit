#!/usr/bin/env python3
"""Stage the proven Seedsow Demo slot-3 correction; never connect to a console."""
import argparse
import hashlib
import importlib.util
import struct
import zlib
import json
import re
import sys
sys.dont_write_bytecode = True
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TITLE = '010042D022AEA000'
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
SOURCE_HASHES = {
    'save0003.dat': 'a903a1f6636e2f33caa435c5859456e4139a8f90e18e5af912a0aa549e4d481f',
    'sed03.asb': 'fb2f16dd185dd481cd861654b51f9c2944a219aad640bef140f1ed28b33d4c56',
    'ssedit3.lua': 'c190dda9ff8a282cdd69222411886c2aff6824462914909552ba0aed4f0233b9',
    'ssseed003.bin': 'a903a1f6636e2f33caa435c5859456e4139a8f90e18e5af912a0aa549e4d481f',
    'ssboot3.bin': 'fb2f16dd185dd481cd861654b51f9c2944a219aad640bef140f1ed28b33d4c56',
    'ssethumb.png': '2f4e2ede1bcd93848291154a6bb2d2bd048098345167ec71954006612b64b331',
}
RESTORE_HASH = 'cf647505fadd66594db84d2ddc63cbde97369e477176ee13c8234b49ff18b893'
REGISTRATION_HASH = 'd7d9bc47424d7dc5cfb13c7debe2fff09800c22b49cda53353ae8f8c4e26ed6e'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def no_symlinks(path):
    path = Path(path).absolute()
    if '..' in path.parts or any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('Expected a non-symlink path without parent traversal: ' + str(path))
    return path


def regular(path):
    path = no_symlinks(path)
    if not path.is_file() or path.stat().st_size > MAX_FILE:
        raise ValueError('Expected a regular input file no larger than 8 MiB')
    return path


def backup_files(manifest_path):
    manifest_path = regular(manifest_path)
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    if manifest.get('complete') is not True or manifest.get('hostIndependentReadbackVerified') is not True:
        raise ValueError('Complete independently hash-read-back backup required')
    identity = manifest.get('evidence', {}).get('targetIdentity') or {}
    if identity.get('applicationId', '').upper() != TITLE:
        raise ValueError('Backup must identify Seedsow Lullaby Demo')
    for key, size in (('userId', 32), ('saveId', 16)):
        value = identity.get(key, '')
        if key == 'saveId' and not value:
            continue
        if not isinstance(value, str) or not re.fullmatch(r'[0-9A-Fa-f]{%d}' % size, value) or int(value, 16) == 0:
            raise ValueError('Nonzero raw account UID/save ID required')
    directory = no_symlinks(manifest_path.parent / 'files')
    if not directory.is_dir():
        raise ValueError('Expected complete backup/files directory')
    records = manifest.get('files')
    if not isinstance(records, list) or not 1 <= len(records) <= 1024:
        raise ValueError('Expected bounded complete backup manifest')
    originals, aliases, total = {}, set(), 0
    for record in records:
        name = record.get('path', '')
        if not isinstance(name, str) or not re.fullmatch(r'/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}', name) or '..' in name:
            raise ValueError('Unsupported save-root backup path')
        if name.lower() in aliases:
            raise ValueError('Duplicate or case-alias backup path')
        aliases.add(name.lower())
        data = regular(directory / name[1:]).read_bytes()
        total += len(data)
        if total > MAX_TOTAL or record.get('bytes') != len(data) or record.get('sha256') != sha(data):
            raise ValueError('Backup size or hash differs')
        originals[name] = data
    if {x.name for x in directory.iterdir()} != {x[1:] for x in originals}:
        raise ValueError('Backup directory differs from its complete manifest')
    return manifest_path, raw, identity, directory, originals


def plan(backup_manifest, editor_dir=None, phase='correction'):
    manifest_path, raw, identity, backup, originals = backup_files(backup_manifest)
    editor_dir = no_symlinks(editor_dir) if editor_dir else None
    if phase != 'baseline' and editor_dir is None:
        raise ValueError('Editor directory is required for this phase')
    source = {}
    for name, digest in (SOURCE_HASHES.items() if phase != 'baseline' else []):
        data = regular(editor_dir / name).read_bytes()
        if sha(data) != digest:
            raise ValueError('Editor recipe source differs: ' + name)
        source[name] = data
    restored = regular(ROOT / 'payloads/restore-launch-marker.lua').read_bytes()
    if sha(restored) != RESTORE_HASH:
        raise ValueError('Restored boot-body source differs')
    if phase == 'baseline':
        if '/ns2jb-off.txt' in originals:
            raise ValueError('Existing launcher disable marker requires review')
        if '/ssslot004.ref' in originals and originals['/ssslot004.ref'].strip() != b'sscode004.lua':
            raise ValueError('Existing slot 4 points elsewhere; preserve it for review')
        seeds = ['/autosave.dat'] if '/autosave.dat' in originals else sorted(
            (name for name in originals if re.fullmatch(r'/save[0-9]{4}\.dat', name)
             and name != '/save9999.dat'), reverse=True)
        if not seeds:
            raise ValueError('No personal autosave/manual save seed')
        spec = importlib.util.spec_from_file_location('baseline_artemis', ROOT / 'tools/artemis-save.py')
        artemis = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = artemis
        spec.loader.exec_module(artemis)
        stub_source = regular(ROOT / 'payloads/ns2jb-stub.lua').read_text()
        stub = artemis.encode_asb([('lua', {'script': stub_source}),
            ('calllua', {'function': 'ns2jb_boot'}),
            ('wait', {'time': '0', 'input': '0'}), ('stop', {})])
        if sha(stub) != 'f800caa253ec0c3a7a441550a1522c0edf21fc8c5861d366a3f594bf13619216':
            raise ValueError('Generated baseline stub differs from the successful recipe')
        launcher, _ = artemis.launch(originals[seeds[0]], 'ns2jb.asb')
        staged = {'/ns2jb.asb': stub, '/save9999.dat': launcher,
                  '/ns2jb.lua': restored, '/sscode004.lua': restored}
    elif phase == 'prerequisites':
        if sha(originals.get('/ns2jb.lua', b'')) != RESTORE_HASH:
            raise ValueError('Original boot body differs from the prerequisite precondition')
        staged = {'/' + name: data for name, data in source.items()}
        staged['/save0003.png'] = source['ssethumb.png']
        staged['/save0003_s.png'] = source['ssethumb.png']
        if any(name in originals for name in staged):
            raise ValueError('Prerequisite assets are add-only; existing slot 3/assets require review')
        registration = regular(ROOT / 'payloads/register-editor-slot3.lua').read_bytes()
        if sha(registration) != REGISTRATION_HASH:
            raise ValueError('Temporary registration source differs')
        staged['/ns2jb.lua'] = registration
    elif phase == 'correction':
        for name in SOURCE_HASHES:
            if name == 'save0003.dat':
                continue
            if originals.get('/' + name) != source[name]:
                raise ValueError('Prerequisite editor asset missing or changed: ' + name)
        native_slot = originals.get('/save0003.dat')
        if native_slot is None or native_slot == source['save0003.dat']:
            raise ValueError('Create a normal game save in slot 3, then take a fresh backup')
        spec = importlib.util.spec_from_file_location('slot3_artemis', ROOT / 'tools/artemis-save.py')
        artemis = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = artemis
        spec.loader.exec_module(artemis)
        try:
            native = artemis.IndexedSave(native_slot)
            caret = native.groups[native.groups[0][3]]
            script = native.lp(caret[3])
            native.num(caret[1])
            native.num(caret[4])
            if not script.startswith(b'system/'):
                raise ValueError('Native slot must resume an ordinary game script')
        except (ValueError, KeyError, struct.error, zlib.error) as error:
            raise ValueError('Slot 3 is not a structurally valid native game save') from error
        if sha(originals.get('/ns2jb.lua', b'')) != REGISTRATION_HASH:
            raise ValueError('Current boot body differs from the successful correction precondition')
        staged = {'/save0003.dat': source['save0003.dat'], '/ns2jb.lua': restored}
    else:
        raise ValueError('Unknown phase')
    projected = {**originals, **staged}
    if len(projected) > 1024 or len({name.lower() for name in projected}) != len(projected):
        raise ValueError('Projected save exceeds entry budget or has case aliases')
    if any(len(data) > MAX_FILE for data in projected.values()) or sum(map(len, projected.values())) > MAX_TOTAL:
        raise ValueError('Projected save exceeds staging byte budget')
    return manifest_path, raw, identity, backup, originals, staged, editor_dir


def build(backup_manifest, editor_dir, output, phase='correction'):
    manifest_path, raw, identity, backup, originals, staged, editor_dir = plan(backup_manifest, editor_dir, phase)
    output = no_symlinks(output)
    for input_dir in (manifest_path.parent, editor_dir):
        if input_dir and (output == input_dir or input_dir in output.parents):
            raise ValueError('Output must be outside input directories')
    output.mkdir(mode=0o700, exist_ok=False)
    files = output / 'files'
    files.mkdir(mode=0o700)
    jobs = []
    for name, data in staged.items():
        dest = files / name[1:]
        with dest.open('xb') as stream:
            stream.write(data)
        if dest.read_bytes() != data:
            raise ValueError('Host staged byte readback failed')
        job = {'path': name, 'local': str(dest), 'bytes': len(data), 'sha256': sha(data)}
        if name in originals:
            job.update(replace=True, originalSHA256=sha(originals[name]))
        jobs.append(job)
    result = {'title': 'Seedsow Demo ' + phase + ' stage',
        'targetApplicationId': TITLE, 'userId': identity['userId'], 'saveId': identity.get('saveId'),
        'backup': str(backup), 'backupManifest': str(manifest_path),
        'backupManifestSHA256': sha(raw), 'files': jobs,
        'editorSourceDirectory': str(editor_dir) if editor_dir else None,
        'phase': phase, 'preservedFiles': len(set(originals) - set(staged)), 'hostStageOnly': True,
        'deviceInstallationPerformed': False, 'rebootPersistenceVerified': False}
    (output / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup-manifest', required=True, type=Path)
    parser.add_argument('--editor-dir', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--phase', choices=['baseline', 'prerequisites', 'correction'], default='correction')
    args = parser.parse_args()
    try:
        result = build(args.backup_manifest, args.editor_dir, args.output, args.phase)
    except (ValueError, OSError, KeyError, TypeError, AttributeError, struct.error, zlib.error) as error:
        parser.exit(1, 'Staging refused: ' + str(error) + '\n')
    print(json.dumps({'hostStageOnly': True, 'files': len(result['files']),
        'manifest': str(args.output / 'manifest.json')}))


if __name__ == '__main__':
    main()
