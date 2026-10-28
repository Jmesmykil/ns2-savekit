#!/usr/bin/env python3
"""Validate a bound stage, run its pinned writer once, and require complete readback."""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('write_backup', ROOT / 'tools/record-save-backup.py')
backup_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup_tool)
prep = backup_tool.prep
WRITER_HASH = 'b93daae795ebe5128127f81ed0dc311974cb1116e942a1add34f093411e2436e'
PHASE_TARGETS = {
    'baseline': {'/ns2jb.asb', '/save9999.dat', '/ns2jb.lua', '/sscode004.lua'},
    'prerequisites': {'/save0003.dat', '/save0003.png', '/save0003_s.png', '/sed03.asb',
        '/ssedit3.lua', '/ssseed003.bin', '/ssboot3.bin', '/ssethumb.png', '/ns2jb.lua'},
    'correction': {'/save0003.dat', '/ns2jb.lua'},
}


def validate(run, writer, manifest_path):
    run = prep.no_symlinks(run)
    writer = prep.regular(writer)
    if prep.sha(writer.read_bytes()) != WRITER_HASH:
        raise ValueError('Writer differs from the pinned successful source')
    manifest_path = prep.regular(manifest_path)
    raw = manifest_path.read_bytes()
    stage = json.loads(raw)
    if stage.get('targetApplicationId') != prep.TITLE or stage.get('hostStageOnly') is not True:
        raise ValueError('Expected a prepared Seedsow Demo stage')
    targets = PHASE_TARGETS.get(stage.get('phase'))
    jobs = stage.get('files')
    if not targets or not isinstance(jobs, list) or len(jobs) != len(targets) or {job.get('path') for job in jobs} != targets:
        raise ValueError('Stage file targets/count differ from the selected phase')
    backup_manifest = prep.regular(stage['backupManifest'])
    if prep.sha(backup_manifest.read_bytes()) != stage.get('backupManifestSHA256'):
        raise ValueError('Backup manifest hash differs')
    _, backup_raw, identity, directory, originals = prep.backup_files(backup_manifest)
    if stage.get('userId') != identity['userId'] or stage.get('saveId') != identity.get('saveId') or stage.get('backup') != str(directory):
        raise ValueError('Stage and backup identity/path differ')
    record = json.loads(backup_raw)
    evidence = record.get('evidence', {})
    session = backup_tool.run_identity(run)
    if evidence.get('runDirectory') != str(run) or evidence.get('session') != session:
        raise ValueError('Backup belongs to a different run/session')
    receipt_path = prep.regular(backup_manifest.parent / 'pull-result.json')
    if evidence.get('pullReceipt') != str(receipt_path):
        raise ValueError('Backup receipt path differs')
    receipt = json.loads(receipt_path.read_bytes())
    reservation = json.loads(prep.regular(run / '.savekit-backup-reserved.json').read_bytes())
    transaction = evidence.get('transaction')
    if not transaction or any(item.get('runDirectory') != str(run) or item.get('session') != session or item.get('transaction', item.get('id')) != transaction for item in (receipt, reservation)):
        raise ValueError('Backup transaction binding differs')
    if receipt.get('complete') is not True or receipt.get('returncode') != 0 or receipt.get('sourceSHA256') != backup_tool.PULL_HASH or receipt.get('manifestSHA256') != prep.sha(backup_raw):
        raise ValueError('Backup pull was not completely accepted')
    staged = {}
    for job in jobs:
        name = job['path']
        local = prep.regular(job['local'])
        if local.parent != manifest_path.parent / 'files' or local.name != name[1:]:
            raise ValueError('Staged file is outside its owned files directory')
        data = local.read_bytes()
        if len(data) != job.get('bytes') or prep.sha(data) != job.get('sha256'):
            raise ValueError('Staged file size/hash differs')
        if name in originals:
            if job.get('replace') is not True or job.get('originalSHA256') != prep.sha(originals[name]):
                raise ValueError('Replacement backup guard differs')
        elif job.get('replace') or job.get('originalSHA256'):
            raise ValueError('Added file is incorrectly marked as replacement')
        staged[name] = data
    if {f.name for f in (manifest_path.parent / 'files').iterdir()} != {name[1:] for name in targets}:
        raise ValueError('Staged directory contains unrecorded entries')
    phase = stage['phase']
    expected = dict(prep.SOURCE_HASHES)
    expected.update({'save0003.png': prep.SOURCE_HASHES['ssethumb.png'],
        'save0003_s.png': prep.SOURCE_HASHES['ssethumb.png'],
        'ns2jb.lua': prep.REGISTRATION_HASH if phase == 'prerequisites' else prep.RESTORE_HASH,
        'sscode004.lua': prep.RESTORE_HASH,
        'ns2jb.asb': 'f800caa253ec0c3a7a441550a1522c0edf21fc8c5861d366a3f594bf13619216'})
    for name, data in staged.items():
        if name == '/save9999.dat':
            continue
        if prep.sha(data) != expected.get(name[1:]):
            raise ValueError('Staged bytes differ from the successful recipe: ' + name)
    _, _, _, _, planned_originals, planned, _ = prep.plan(
        backup_manifest, stage.get('editorSourceDirectory'), phase)
    if planned_originals != originals or planned != staged:
        raise ValueError('Stage differs from the required phase plan')
    if manifest_path.read_bytes() != raw:
        raise ValueError('Stage manifest changed during validation')
    return run, writer, manifest_path, stage, originals, staged


def check_readback(text, originals, staged):
    if text.splitlines().count('commit -> 0x0') != 1:
        raise ValueError('Exactly one successful commit was not recorded')
    pattern = re.compile(r'^  (\S+)\s+(\d+)\s+([0-9a-f]{16})\s+(?:(\(written ok\)|\(WRITE MISMATCH\))\s+)?(ok|DIFFERS|n/a)$')
    rows = {}
    for line in text.splitlines():
        if re.match(r'^  \S+\s+<not a file:', line):
            raise ValueError('Unexpected non-file readback entry')
        match = pattern.fullmatch(line)
        if match:
            name, size, digest, tag, status = match.groups()
            if '/' + name in rows:
                raise ValueError('Duplicate readback row')
            rows['/' + name] = (int(size), digest, tag, status)
    expected = {**originals, **staged}
    if set(rows) != set(expected):
        raise ValueError('Readback is missing files or contains unexpected entries')
    for name, data in expected.items():
        size, digest, tag, status = rows[name]
        if size != len(data) or digest != prep.sha(data)[:16]:
            raise ValueError('Readback size/hash prefix differs: ' + name)
        if name in staged:
            if tag != '(written ok)':
                raise ValueError('Pinned writer did not confirm full staged hash: ' + name)
        elif tag is not None or status != 'ok':
            raise ValueError('Original file changed: ' + name)
    return {'writtenFiles': len(staged), 'preservedFiles': len(set(originals) - set(staged))}


def write(run, writer, manifest):
    run, writer, manifest, stage, originals, staged = validate(run, writer, manifest)
    reservation = run / '.savekit-write-reserved.json'
    with reservation.open('x') as stream:
        stream.write(json.dumps({'manifest': str(manifest), 'manifestSHA256': prep.sha(manifest.read_bytes())}) + '\n')
    log = manifest.parent / 'write.log'
    receipt = {'complete': False, 'retryPerformed': False, 'runDirectory': str(run),
        'writerSHA256': WRITER_HASH, 'manifestSHA256': prep.sha(manifest.read_bytes()),
        'command': ['node', str(writer), str(run), prep.TITLE, stage['userId'], stage['backup'], str(manifest)]}
    try:
        with log.open('x') as stream:
            result = subprocess.run(receipt['command'], stdout=stream, stderr=subprocess.STDOUT, timeout=600)
        receipt['returncode'] = result.returncode
        if result.returncode != 0:
            raise ValueError('Writer failed; outcome must be reviewed, not retried')
        receipt.update(check_readback(log.read_text(), originals, staged), complete=True)
        return receipt
    except BaseException as error:
        receipt['error'] = str(error)
        raise
    finally:
        (manifest.parent / 'write-result.json').write_text(json.dumps(receipt, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--writer', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(write(args.run, args.writer, args.manifest), indent=2))
    except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired) as error:
        parser.exit(1, 'Write refused: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
