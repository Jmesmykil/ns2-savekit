#!/usr/bin/env python3
"""Run one upstream read-only Demo pull and record its host inventory, without retry."""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
import uuid
sys.dont_write_bytecode = True
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('backup_stage', ROOT / 'tools/prepare-editor-slot.py')
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)


PULL_HASH = 'a925b493f669c99f67c8cce0be766fe1ca72af4a4e7806e296467ff1e9451036'


def run_identity(run):
    current = json.loads(prep.regular(run / 'switch2/current-acquisition.json').read_bytes())
    root = json.loads(prep.regular(run / 'switch2/ro/root/current-root.json').read_bytes())
    if not isinstance(current.get('session'), str) or not current['session'] or root.get('session') != current['session'] or root.get('pid') != 1 or not root.get('rootHandle'):
        raise ValueError('Run has no matching promoted filesystem-root identity')
    return current['session']


def capture(run, uid, save_id, output, pull_tool):
    for value, size in ((uid, 32), (save_id, 16)):
        if size == 16 and value is None:
            continue
        if not re.fullmatch(r'[0-9A-Fa-f]{%d}' % size, value) or int(value, 16) == 0:
            raise ValueError('Provide nonzero raw account UID and save ID in hexadecimal')
    run = prep.no_symlinks(run)
    if not run.is_dir():
        raise ValueError('Run directory does not exist')
    output = prep.no_symlinks(output)
    if output == run or run in output.parents:
        raise ValueError('Backup output must be outside the run directory')
    script = prep.regular(pull_tool)
    if prep.sha(script.read_bytes()) != PULL_HASH:
        raise ValueError('Pull tool differs from the pinned successful source')
    session = run_identity(run)
    output.mkdir(mode=0o700, exist_ok=False)
    files = output / 'files'
    files.mkdir(mode=0o700)
    log = output / 'pull.log'
    transaction = {'runDirectory': str(run), 'session': session, 'id': str(uuid.uuid4())}
    reservation = run / '.savekit-backup-reserved.json'
    with reservation.open('x') as stream:
        stream.write(json.dumps(transaction, sort_keys=True) + '\n')
    receipt = {'runDirectory': str(run), 'session': session, 'transaction': transaction['id'], 'complete': False, 'hostIndependentReadbackVerified': False,
        'deviceProvenanceAuthenticated': False, 'saveIdSource': 'caller-supplied',
        'applicationId': prep.TITLE, 'userId': uid, 'saveId': save_id,
        'sourceSHA256': prep.sha(script.read_bytes()), 'retryPerformed': False,
        'command': ['node', str(script), str(run), prep.TITLE, str(files), uid]}
    try:
        with log.open('x') as stream:
            result = subprocess.run(receipt['command'], stdout=stream,
                stderr=subprocess.STDOUT, timeout=600)
        receipt['returncode'] = result.returncode
        if result.returncode != 0:
            raise ValueError('Read-only pull failed; preserve its log and do not reuse this session')
        text = log.read_text()
        success = re.findall(r'^  space=(\S+) type=(\S+) uid=([0-9a-fA-F]+) -> ok$', text, re.M)
        mounted = re.findall(r'^mounted space=User type=Account uid=([0-9a-f]{32})$', text, re.M)
        if success != [('User', 'Account', uid[:16].lower())] or mounted != [uid.lower()]:
            raise ValueError('Pull did not report the expected User/Account open')
        done = re.findall(r'^done: (\d+) files, (\d+) bytes -> (.+)$', text, re.M)
        if len(done) != 1 or Path(done[0][2]) != files:
            raise ValueError('Pull completion record missing or mismatched')
        count, total = map(int, done[0][:2])
        listed = re.findall(r'^  (/[^\n]+) \((\d+) bytes\)$', text, re.M)
        expected = {name: int(size) for name, size in listed}
        if not 1 <= count <= 1024 or len(listed) != count or len(expected) != count:
            raise ValueError('Pull file listing incomplete or duplicated')
        if total > prep.MAX_TOTAL or sum(expected.values()) != total:
            raise ValueError('Pull byte totals differ or exceed budget')
        records = []
        for name, size in sorted(expected.items()):
            if not re.fullmatch(r'/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}', name) or '..' in name:
                raise ValueError('Nested or unsafe backup paths are unsupported')
            path = prep.regular(files / name[1:])
            data = path.read_bytes()
            if len(data) != size or path.read_bytes() != data:
                raise ValueError('Host backup size or second read differs')
            records.append({'path': name, 'bytes': size, 'sha256': prep.sha(data)})
        manifest = {'complete': True, 'hostIndependentReadbackVerified': True,
            'evidence': {'targetIdentity': {'applicationId': prep.TITLE,
                'userId': uid, 'saveId': save_id}, 'deviceProvenanceAuthenticated': False,
                'runDirectory': str(run), 'session': session, 'transaction': transaction['id'],
                'identitySource': 'title fixed by tool; raw UID and optional descriptive save ID supplied by caller',
                'completenessSource': 'successful pull exit, complete logged listing and matching host files',
                'pullReceipt': str(output / 'pull-result.json')}, 'files': records}
        pending = output / 'manifest.pending.json'
        pending.write_text(json.dumps(manifest, indent=2) + '\n')
        # Apply the same complete-directory, duplicate/case and hash validation
        # used by staging before recording the pull as accepted.
        prep.backup_files(pending)
        target = output / 'manifest.json'
        pending.rename(target)
        receipt.update(complete=True, hostIndependentReadbackVerified=True,
            files=count, bytes=total, manifestSHA256=prep.sha(target.read_bytes()))
        return target
    except BaseException as error:
        receipt['error'] = str(error)
        raise
    finally:
        (output / 'pull-result.json').write_text(json.dumps(receipt, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--uid', required=True)
    parser.add_argument('--save-id', help='Optional descriptive ID; not an OS-validated selection key')
    parser.add_argument('--pull-tool', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        manifest = capture(args.run, args.uid, args.save_id, args.output, args.pull_tool)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        parser.exit(1, 'Backup refused: ' + str(error) + '\n')
    print(json.dumps({'manifest': str(manifest), 'hostIndependentReadbackVerified': True,
                      'deviceProvenanceAuthenticated': False}))


if __name__ == '__main__':
    main()
