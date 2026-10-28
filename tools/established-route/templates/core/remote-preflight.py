#!/usr/bin/env python3
"""Fixed read-only input privilege probe. Never opens a lock or HID device."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

ROOT = Path('__REMOTE_INPUT_ROOT__')
ENCODER_SHA = 'a0a0e5376586367cac4875038e969515f4922e1f07fb63b87e94a07cdfca9f8c'


def payload(raw):
    # sudo may consume the credential line or leave it when auth is cached.
    # The final line is always the one-line JSON payload; never echo any line.
    lines = raw.split(b'\n')
    if len(raw) > 8192 or len(lines) not in (1, 2):
        raise ValueError('Unexpected private input framing')
    value = json.loads(lines[-1])
    if value != {'action': 'preflight'}:
        raise ValueError('Expected fixed read-only preflight request')


def metadata(path):
    record = {'path': str(path), 'readable': os.access(path, os.R_OK),
              'writable': os.access(path, os.W_OK), 'searchable': os.access(path, os.X_OK)}
    try:
        s = path.lstat()
        record.update({'exists': True, 'uid': s.st_uid, 'gid': s.st_gid, 'mode': oct(stat.S_IMODE(s.st_mode)),
                       'isSymlink': stat.S_ISLNK(s.st_mode), 'isDirectory': stat.S_ISDIR(s.st_mode),
                       'isRegular': stat.S_ISREG(s.st_mode), 'isCharacter': stat.S_ISCHR(s.st_mode)})
    except OSError as error:
        record.update({'exists': False, 'error': type(error).__name__})
    return record


def probe():
    source = ROOT / 'pi_hid_type.py'
    controllers = sorted(Path('/sys/class/udc').iterdir())
    hardware = {'controllers': len(controllers)}
    if len(controllers) == 1:
        hardware.update({'state': (controllers[0] / 'state').read_text().strip(),
                         'speed': (controllers[0] / 'current_speed').read_text().strip()})
    hardware['serial'] = Path('__SERIAL_PATH__').read_text().strip()
    return {'schema': 1, 'readOnly': True, 'openedHID': False, 'openedLock': False, 'reservedPhase': False,
            'effectiveUid': os.geteuid(), 'encoderSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'hardware': hardware, 'paths': {'receipts': metadata(ROOT / 'hb-attempts'),
                                          'lock': metadata(ROOT / 'hb-attempts/session.lock'),
                                          'hid': metadata(Path('__HID_DEVICE__'))}}


if __name__ == '__main__':
    try:
        payload(sys.stdin.buffer.read(8193))
        print(json.dumps(probe()))
    except BaseException as error:
        # Never render stdin, credentials, exception repr or arbitrary text.
        print(json.dumps({'schema': 1, 'readOnly': True, 'openedHID': False, 'openedLock': False,
                          'reservedPhase': False, 'error': type(error).__name__}))
        raise SystemExit(1)
