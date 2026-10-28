#!/usr/bin/env python3
"""One reserved input phase over stdin; no setup, descriptors or service changes."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path('__REMOTE_INPUT_ROOT__')
ENCODER_SHA = 'a0a0e5376586367cac4875038e969515f4922e1f07fb63b87e94a07cdfca9f8c'
PHASES = ('load', 'load-confirm', 'run', 'remove', 'start')


def validate(ticket, now=None):
    now = time.time() if now is None else now
    if not re.fullmatch(r'l02-[0-9a-f-]{36}', ticket.get('attempt', '')):
        raise ValueError('Unexpected attempt identity')
    if ticket.get('phase') not in PHASES:
        raise ValueError('Expected exactly one input phase')
    if not 0 <= ticket.get('expiresUnix', 0) - now <= 540:
        raise ValueError('Input ticket expired or implausible')
    if ticket.get('encoderSha256') != ENCODER_SHA:
        raise ValueError('Encoder pin differs')
    phase = ticket['phase']
    commands = {'load': 'LOAD "TXT:NS2GOOD"', 'load-confirm': None, 'run': 'RUN',
                'remove': 'REMOVE NSR,&H60000000,&H3FFFFFFF'}
    command = ticket.get('command')
    if hashlib.sha256((command or 'KEYS:RIGHT,A').encode()).hexdigest() != ticket.get('commandSha256'):
        raise ValueError('Input command digest differs')
    if phase == 'start':
        if not isinstance(command, str) or not re.fullmatch(r'V=START\(__START_ENDPOINT_REGEX__,\d+,\d+,\d+,\d+\)', command):
            raise ValueError('START endpoint or shape differs')
        values = [int(x) for x in command[8:-1].split(',')]
        if any(not 0 <= x < 2**48 for x in values[5:]) or len(set(values[5:])) < 2:
            raise ValueError('Expected fresh pairing values')
    elif command != commands[phase]:
        raise ValueError('Input does not match the single selected phase')
    return ticket


def payload(raw):
    # The credential line may be consumed by sudo or left when auth is cached.
    # Only the final one-line JSON ticket is parsed; no input line is logged.
    lines = raw.split(b'\n')
    if len(raw) > 8192 or len(lines) not in (1, 2):
        raise ValueError('Unexpected private input framing')
    return json.loads(lines[-1])


def hardware():
    controllers = list(Path('/sys/class/udc').iterdir())
    if len(controllers) != 1:
        raise ValueError('Expected one USB device controller')
    controller = controllers[0]
    if (controller / 'state').read_text().strip() != 'configured' or (controller / 'current_speed').read_text().strip() != 'full-speed':
        raise ValueError('Keyboard is not at its verified configured full-speed state')
    serial = Path('__SERIAL_PATH__')
    if serial.read_text().strip() != '__USB_SERIAL__':
        raise ValueError('Existing keyboard ownership differs')


def dispatch(ticket):
    validate(ticket)
    source = ROOT / 'pi_hid_type.py'
    if hashlib.sha256(source.read_bytes()).hexdigest() != ENCODER_SHA:
        raise ValueError('Installed encoder differs from reviewed source')
    spec = importlib.util.spec_from_file_location('l02_pinned_encoder', source)
    encoder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(encoder)
    hardware()
    strokes = None if ticket['phase'] == 'load-confirm' else encoder.plan(ticket['command'], False, 'upper-default')
    receipts = ROOT / 'hb-attempts'
    receipts.mkdir(mode=0o700, exist_ok=True)
    if receipts.is_symlink():
        raise ValueError('Receipt directory must not be a symlink')
    with (receipts / 'session.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        file = receipts / (ticket['attempt'] + '.' + ticket['phase'] + '.jsonl')
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as ledger:
            def event(kind, **fields):
                item = {'kind': kind, 'attempt': ticket['attempt'], 'phase': ticket['phase'],
                        'unix': time.time(), 'visualVerification': False, **fields}
                ledger.write(json.dumps(item) + '\n')
                ledger.flush()
                os.fsync(ledger.fileno())
            event('reserved', commandSha256=ticket['commandSha256'])
            try:
                validate(ticket)
                hardware()
                if strokes is not None:
                    encoder.send('__HID_DEVICE__', strokes, 60, 120, 60)
                    time.sleep(.35)
                for key in ((79, 4) if strokes is None else (79, 77, 40)):
                    validate(ticket)
                    hardware()
                    encoder.send('__HID_DEVICE__', [(0, key)], 120, 120, 120)
                event('dispatched')
            except BaseException as error:
                event('uncertain', error=type(error).__name__, replayAllowed=False)
                raise
    return {'attempt': ticket['attempt'], 'phase': ticket['phase'], 'dispatched': True,
            'visualVerification': False, 'receipt': str(file)}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(8193)
        print(json.dumps(dispatch(payload(raw))))
    except BaseException as error:
        print(json.dumps({'error': type(error).__name__,
                          'replayAllowed': False}), file=sys.stderr)
        raise SystemExit(1)
