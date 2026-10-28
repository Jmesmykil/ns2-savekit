#!/usr/bin/env python3
"""Fresh-attempt input journal and separate phase dispatch. No combined path."""
import argparse
import contextlib
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import time
import uuid
import warnings

ROOT = Path(__file__).resolve().parent
SSH_CONFIG = Path('__SSH_CONFIG__')
PHASES = ('load', 'load-confirm', 'run', 'remove', 'start')
OBSERVED = {'load': ('load-modal', 'direct-loaded'), 'load-confirm': ('direct-loaded',),
            'run': ('boot-ready',), 'remove': ('expected-out-of-memory',), 'start': ('host-qualified',)}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def exclusive(file, data):
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())


def source_pins(root=ROOT):
    owner = json.loads((root / 'ownership.json').read_text())
    for record in owner['sources']:
        if digest((root / record['copy']).read_bytes()) != record['sha256']:
            raise ValueError('Pinned source changed: ' + record['copy'])
    names = sorted(['host.cjs', 'phase.py', 'remote-phase.py', 'remote-preflight.py', 'ownership.json', 'route-config.private.json'] + [x['copy'] for x in owner['sources']])
    entries = [[name, digest((root / name).read_bytes())] for name in names]
    return digest(json.dumps(entries, separators=(',', ':')).encode())


def load_launch(directory, root=ROOT):
    directory = Path(directory).resolve(strict=True)
    if directory.parent != (root / 'attempts').resolve(strict=True):
        raise ValueError('Expected a direct child of this package attempts directory')
    data = json.loads((directory / 'launch.json').read_text())
    if data['directory'] != str(directory) or data['attempt'] != directory.name or data['pins']['digest'] != source_pins(root):
        raise ValueError('Attempt identity or source digest differs')
    if data['host'] != '__HOST__' or data['port'] != __PORT__:
        raise ValueError('Host endpoint differs')
    command = 'V=START(' + ','.join(str(x) for x in [__PORT__, *__HOST_OCTETS__] + data['token']) + ')'
    if data['connectCommand'] != command or (directory / 'connect.txt').read_text() != command + '\n':
        raise ValueError('Private pairing differs')
    return data


def live_control(launch, command='status', **fields):
    status = json.loads((Path(launch['directory']) / 'status.json').read_text())
    port = status['controlPort']
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError('Unexpected local control port')
    request = {'token': launch['controlToken'], 'attempt': launch['attempt'],
               'incarnation': launch['incarnation'], 'command': command, **fields}
    raw = b''
    with socket.create_connection(('127.0.0.1', port), timeout=4) as client:
        client.settimeout(125 if command == 'sample' else 5)
        client.sendall((json.dumps(request) + '\n').encode())
        while not raw.endswith(b'\n'):
            part = client.recv(4096)
            if not part:
                break
            raw += part
            if len(raw) > 65536:
                raise ValueError('Control reply too large')
    reply = json.loads(raw)
    if not reply.get('ok'):
        raise ValueError(reply.get('error', 'Control request rejected'))
    if reply.get('attempt') != launch['attempt'] or reply.get('incarnation') != launch['incarnation'] or reply.get('pinsDigest') != launch['pins']['digest'] or reply.get('pid') != status['pid']:
        raise ValueError('Live host identity differs from the attempt')
    if not (command == 'stop' and reply.get('state') == 'CLOSED' and reply.get('result', {}).get('closed') is True):
        os.kill(reply['pid'], 0)
    return reply


def check_waiting(launch, reply, now=None):
    now = time.time() * 1000 if now is None else now
    if reply.get('state') != 'WAITING' or reply.get('listenerReady') is not True:
        raise ValueError('Current matching host is not awaiting this pairing')
    if not 0 < reply.get('pairingDeadline', 0) - now <= 540000:
        raise ValueError('Host pairing expired or deadline differs')
    return reply


def capture(path, reserved_after_ns=0):
    path = Path(path).resolve(strict=True)
    raw = path.read_bytes()
    if not raw.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Expected a PNG screen capture')
    if path.stat().st_mtime_ns < reserved_after_ns:
        raise ValueError('Capture predates the phase reservation')
    return {'path': str(path), 'sha256': digest(raw), 'bytes': len(raw), 'mtimeNs': path.stat().st_mtime_ns,
            'visualInterpretation': 'Explicit operator observation; hash alone does not interpret screen content'}


@contextlib.contextmanager
def locked(directory):
    with (directory / 'phases' / 'journal.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def verify_capture(record, earliest_ns=0):
    current = capture(record['path'], earliest_ns)
    if current['sha256'] != record['sha256'] or current['bytes'] != record['bytes']:
        raise ValueError('Previously confirmed capture changed')
    return current


def epoch_record(launch, closed_capture, direct_capture):
    earliest = int(launch['created']) * 1_000_000
    closed = capture(closed_capture, earliest)
    direct = capture(direct_capture, earliest)
    if closed['sha256'] == direct['sha256'] or closed['mtimeNs'] >= direct['mtimeNs']:
        raise ValueError('Need distinct, ordered app-closed then fresh Direct captures from this attempt')
    return {'attempt': launch['attempt'], 'incarnation': launch['incarnation'], 'sourceDigest': launch['pins']['digest'],
            'freshAppOpenedOperatorConfirmed': True, 'closedCapture': closed, 'directCapture': direct,
            'utcUnixNs': time.time_ns(), 'savedBootstrapSourceHashOnConsole': 'historical comparison; not freshly extracted'}


def operator_attestation(launch, file, expected=None, now_ms=None):
    # This is the operator's statement, not a camera observation or physical timestamp.
    file = Path(file)
    directory = Path(launch['directory']).resolve(strict=True)
    if file != directory / 'operator-ready-attestation.json' or file.resolve(strict=True) != file:
        raise ValueError('Operator attestation must be the owned attempt file')
    st = file.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077 or st.st_uid != os.getuid() or st.st_size > 8192:
        raise ValueError('Private regular operator attestation required')
    raw = file.read_bytes()
    record = {'path': str(file), 'sha256': digest(raw), 'bytes': len(raw)}
    if expected is not None and record != expected:
        raise ValueError('Operator attestation changed')
    data = json.loads(raw)
    now_ms = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    if (data.get('schema') != 1 or data.get('kind') != 'OPERATOR_FRESH_APP_READY'
            or data.get('attempt') != launch['attempt'] or data.get('incarnation') != launch['incarnation']
            or data.get('sourceDigest') != launch['pins']['digest'] or data.get('userQuotation') != 'ready'
            or data.get('operatorFreshAppOpened') is not True or data.get('visualVerification') is not False
            or type(data.get('recordedUnixMs')) is not int
            or not launch['created'] <= data['recordedUnixMs'] <= now_ms):
        raise ValueError('Operator attestation identity or receipt time differs')
    return record


def operator_epoch_record(launch, file):
    return {'attempt': launch['attempt'], 'incarnation': launch['incarnation'], 'sourceDigest': launch['pins']['digest'],
            'freshAppOpenedOperatorConfirmed': True, 'evidenceKind': 'OPERATOR_FRESH_APP_READY',
            'operatorAttestation': operator_attestation(launch, file), 'utcUnixNs': time.time_ns(),
            'savedBootstrapSourceHashOnConsole': 'historical comparison; not freshly extracted'}


def validate_predecessor(directory, phase, launch):
    phases = directory / 'phases'
    if not (phases / 'epoch-confirmed.json').exists():
        raise ValueError('Fresh reopened-app epoch has not been capture-confirmed')
    epoch = json.loads((phases / 'epoch-confirmed.json').read_text())
    if epoch.get('attempt') != launch['attempt'] or epoch.get('incarnation') != launch['incarnation'] or epoch.get('sourceDigest') != launch['pins']['digest'] or epoch.get('freshAppOpenedOperatorConfirmed') is not True:
        raise ValueError('Fresh epoch identity differs')
    if epoch.get('evidenceKind') == 'OPERATOR_FRESH_APP_READY':
        operator_attestation(launch, epoch['operatorAttestation']['path'], epoch['operatorAttestation'])
    else:
        if 'evidenceKind' in epoch:
            raise ValueError('Unsupported epoch evidence kind')
        epoch_record(launch, epoch['closedCapture']['path'], epoch['directCapture']['path'])
        verify_capture(epoch['closedCapture'], int(launch['created']) * 1_000_000)
        verify_capture(epoch['directCapture'], int(launch['created']) * 1_000_000)
    # Any unknown dispatch is terminal for this attempt, even another phase.
    for reserved in phases.glob('*-reserved.json'):
        other = reserved.name[:-len('-reserved.json')]
        result = phases / (other + '-result.json')
        if not result.exists() or not json.loads(result.read_text()).get('dispatched'):
            raise ValueError('An input dispatch is uncertain; preserve and do not continue')
    if (phases / (phase + '-reserved.json')).exists():
        raise ValueError('Selected phase is consumed; no replay')
    if phase == 'load':
        return
    predecessor = {'load-confirm': 'load', 'run': 'load', 'remove': 'run', 'start': 'remove'}[phase]
    prior = json.loads((phases / (predecessor + '-confirmed.json')).read_text())
    def check_prior(record):
        if record.get('attempt') != launch['attempt'] or record.get('sameHostIncarnation') != launch['incarnation']:
            raise ValueError('Predecessor confirmation belongs to a different attempt')
        verify_capture(record['capture'])
    check_prior(prior)
    if phase == 'load-confirm' and prior['observed'] != 'load-modal':
        raise ValueError('Modal confirmation requires a visible LOAD modal')
    if phase == 'run':
        if prior['observed'] == 'load-modal':
            prior = json.loads((phases / 'load-confirm-confirmed.json').read_text())
            check_prior(prior)
        if prior['observed'] != 'direct-loaded':
            raise ValueError('Loaded Direct mode must be capture-confirmed before RUN')


def command_for(launch, phase):
    return {'load': 'LOAD "TXT:NS2GOOD"', 'load-confirm': None, 'run': 'RUN',
            'remove': 'REMOVE NSR,&H60000000,&H3FFFFFFF', 'start': launch['connectCommand']}[phase]


def reserve(launch, phase, reply, now_ns=None):
    directory = Path(launch['directory'])
    validate_predecessor(directory, phase, launch)
    check_waiting(launch, reply)
    now_ns = time.time_ns() if now_ns is None else now_ns
    command = command_for(launch, phase)
    command_sha = digest((command or 'KEYS:RIGHT,ENTER').encode())
    receipt = {'attempt': launch['attempt'], 'incarnation': launch['incarnation'], 'phase': phase,
               'reservedUnixNs': now_ns, 'commandSha256': command_sha, 'sourceDigest': launch['pins']['digest'],
               'outcome': 'unknown until exact successful sender result', 'replayAllowed': False}
    exclusive(directory / 'phases' / (phase + '-reserved.json'), receipt)
    return {'attempt': launch['attempt'], 'phase': phase, 'command': command, 'commandSha256': command_sha,
            'encoderSha256': launch['encoderSha256'], 'expiresUnix': reply['pairingDeadline'] / 1000}


def validate_credential(credential):
    if not isinstance(credential, str) or not credential or '\n' in credential or '\r' in credential or len(credential) > 4096:
        raise ValueError('Expected a nonempty single-line private sudo credential')
    return credential


def prompt_credential():
    if not sys.stdin.isatty():
        raise ValueError('Sudo credential entry requires a private local TTY')
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        try:
            return validate_credential(getpass.getpass('Pi sudo password (not recorded): '))
        except getpass.GetPassWarning:
            raise ValueError('Private no-echo credential entry is unavailable') from None


def redact(value, credential):
    if isinstance(value, str):
        return value.replace(credential, '[redacted]') if credential else value
    if isinstance(value, dict):
        return {redact(key, credential): redact(item, credential) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item, credential) for item in value]
    return value


def remote_call(hostname, source, request, sudo=False, credential=None, run=subprocess.run):
    # SSH keeps its existing trusted-host/key configuration. Secrets travel only
    # through subprocess stdin, never argv, environment, receipts or errors.
    config = SSH_CONFIG.read_text()
    if 'StrictHostKeyChecking yes' not in config or 'HostKeyAlias __SSH_HOST_KEY_ALIAS__' not in config:
        raise ValueError('Existing strict SSH trust contract differs')
    command = (['sudo', '-S', '-p', "''", '--'] if sudo else []) + ['/usr/bin/python3', '-B', '-c', __import__('shlex').quote((ROOT / source).read_text())]
    argv = ['ssh', '-T', '-F', str(SSH_CONFIG), '-o', 'HostName=' + hostname, '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=' + '__SSH_HOST_KEY_ALIAS__', '__SSH_ALIAS__'] + command
    private_input = json.dumps(request, separators=(',', ':'))
    if sudo:
        private_input = validate_credential(credential) + '\n' + private_input
    try:
        completed = run(argv, input=private_input, text=True, capture_output=True, timeout=90)
        try:
            document = json.loads(completed.stdout)
            if not isinstance(document, dict):
                document = None
        except (ValueError, TypeError):
            document = None
        # Raw stdout/stderr can contain authentication diagnostics. Never return
        # or persist either, even on failure or a malformed remote response.
        return {'returncode': completed.returncode, 'document': redact(document, credential), 'transportError': None}
    except (OSError, subprocess.SubprocessError) as error:
        return {'returncode': None, 'document': None, 'transportError': type(error).__name__}
    finally:
        private_input = None


def preflight(hostname, sudo=False, credential=None, run=subprocess.run):
    started = time.time_ns()
    outcome = remote_call(hostname, 'remote-preflight.py', {'action': 'preflight'}, sudo, credential, run)
    d = outcome['document'] or {}
    hardware = d.get('hardware', {})
    paths = d.get('paths', {})
    def accessible(name, kind, write=False, search=False):
        m = paths.get(name, {})
        return (m.get('exists') is True and m.get(kind) is True and m.get('isSymlink') is False
                and m.get('readable') is True and (not write or m.get('writable') is True)
                and (not search or m.get('searchable') is True))
    ready = (outcome['returncode'] == 0 and d.get('schema') == 1 and d.get('readOnly') is True
             and d.get('openedHID') is False and d.get('openedLock') is False and d.get('reservedPhase') is False
             and (not sudo or d.get('effectiveUid') == 0)
             and d.get('encoderSha256') == 'a0a0e5376586367cac4875038e969515f4922e1f07fb63b87e94a07cdfca9f8c'
             and hardware.get('controllers') == 1 and hardware.get('state') == 'configured'
             and hardware.get('speed') == 'full-speed' and hardware.get('serial') == '__USB_SERIAL__'
             and accessible('receipts', 'isDirectory', write=True, search=True)
             and accessible('lock', 'isRegular', write=True) and accessible('hid', 'isCharacter', write=True))
    return {'schema': 1, 'sudoRequested': sudo, 'ready': bool(ready), 'readOnly': True, 'phaseReserved': False,
            'startedUnixNs': started, 'completedUnixMs': time.time_ns() // 1_000_000,
            'sourceDigest': source_pins(),
            'trustedSsh': {'configPath': str(SSH_CONFIG), 'configSha256': digest(SSH_CONFIG.read_bytes()),
                           'hostKeyAlias': '__SSH_HOST_KEY_ALIAS__', 'host': '__SSH_ALIAS__', 'hostnameOverride': hostname},
            'returncode': outcome['returncode'], 'transportError': outcome['transportError'],
            'observation': d, 'rawOutputRetained': False}


def dispatch(launch, phase, hostname, run=subprocess.run, control=live_control, sudo=False, credential=None):
    directory = Path(launch['directory'])
    with locked(directory):
        reply = control(launch)
        check_waiting(launch, reply)
        validate_predecessor(directory, phase, launch)
        probe = preflight(hostname, sudo, credential, run)
        exclusive(directory / 'phases' / ('preflight-' + str(time.time_ns()) + '.json'),
                  {'attempt': launch['attempt'], 'phase': phase, **probe})
        if not probe['ready'] or probe['sourceDigest'] != launch['pins']['digest']:
            raise ValueError('Read-only input preflight did not qualify access; no phase reserved')
        # Read-only preflight does not reserve/consume input. Recheck freshness
        # after it, then fsync the reservation before any HID-capable SSH call.
        ticket = reserve(launch, phase, control(launch))
        try:
            outcome = remote_call(hostname, 'remote-phase.py', ticket, sudo, credential, run)
            result = {'attempt': launch['attempt'], 'phase': phase, 'returncode': outcome['returncode'],
                      'transportError': outcome['transportError'], 'dispatched': False,
                      'visualVerification': False, 'replayAllowed': False, 'sudoRequested': sudo, 'rawOutputRetained': False}
            if outcome['returncode'] == 0 and outcome['document']:
                remote = outcome['document']
                if remote.get('attempt') == launch['attempt'] and remote.get('phase') == phase and remote.get('dispatched') is True:
                    result['dispatched'] = True
                    result['remoteReceipt'] = remote.get('receipt')
            exclusive(directory / 'phases' / (phase + '-result.json'), result)
            if not result['dispatched']:
                raise ValueError('Sender outcome is uncertain; preserve receipts and do not replay')
            return {k: result[k] for k in ['attempt', 'phase', 'returncode', 'dispatched', 'visualVerification', 'replayAllowed']}
        except BaseException as error:
            uncertain = directory / 'phases' / (phase + '-uncertain.json')
            if not uncertain.exists():
                exclusive(uncertain, {'attempt': launch['attempt'], 'phase': phase, 'error': type(error).__name__, 'replayAllowed': False})
            raise


def confirm(launch, phase, screenshot, observed, control=live_control):
    directory = Path(launch['directory'])
    if observed not in OBSERVED[phase]:
        raise ValueError('Observation does not match phase')
    with locked(directory):
        reserved = json.loads((directory / 'phases' / (phase + '-reserved.json')).read_text())
        result = json.loads((directory / 'phases' / (phase + '-result.json')).read_text())
        if not result.get('dispatched'):
            raise ValueError('No completed dispatch to confirm')
        reply = control(launch)
        if phase == 'start':
            if reply.get('state') != 'QUALIFIED' or reply.get('nativeOwnership') is not True:
                raise ValueError('Fresh host qualification has not completed')
        else:
            check_waiting(launch, reply)
        record = {'attempt': launch['attempt'], 'phase': phase, 'observed': observed,
                  'capture': capture(screenshot, reserved['reservedUnixNs']), 'confirmedUnixNs': time.time_ns(),
                  'sameHostIncarnation': launch['incarnation'], 'nativeQualificationChecked': phase == 'start'}
        exclusive(directory / 'phases' / (phase + '-confirmed.json'), record)
        return record


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--attempt', type=Path)
    commands = p.add_subparsers(dest='action', required=True)
    e = commands.add_parser('epoch')
    e.add_argument('--capture')
    e.add_argument('--closed-capture')
    e.add_argument('--fresh-app-opened', action='store_true')
    e.add_argument('--operator-ready-attestation', type=Path)
    d = commands.add_parser('dispatch')
    d.add_argument('--phase', choices=PHASES, required=True)
    d.add_argument('--ssh-hostname', required=True)
    d.add_argument('--sudo', action='store_true')
    f = commands.add_parser('preflight')
    f.add_argument('--ssh-hostname', required=True)
    f.add_argument('--sudo', action='store_true')
    c = commands.add_parser('confirm')
    c.add_argument('--phase', choices=PHASES, required=True)
    c.add_argument('--capture', required=True)
    c.add_argument('--observed', required=True)
    commands.add_parser('status')
    s = commands.add_parser('sample')
    s.add_argument('--label', choices=['before', 'after'], required=True)
    m = commands.add_parser('mark-during')
    m.add_argument('--capture', required=True)
    commands.add_parser('stop')
    a = p.parse_args()
    if a.action == 'preflight':
        credential = prompt_credential() if a.sudo else None
        try:
            result = preflight(a.ssh_hostname, a.sudo, credential)
        finally:
            credential = None
        receipts = ROOT / 'preflight-receipts'
        receipts.mkdir(mode=0o700, exist_ok=True)
        receipt = receipts / ('preflight-' + str(uuid.uuid4()) + '.json')
        exclusive(receipt, {'purpose': 'input-preflight', **result})
        print(json.dumps({**result, 'receiptPath': str(receipt)}, indent=2))
        return 0 if result['ready'] else 1
    if a.attempt is None:
        raise ValueError('This action requires --attempt')
    launch = load_launch(a.attempt)
    if a.action == 'epoch':
        check_waiting(launch, live_control(launch))
        with locked(Path(launch['directory'])):
            if a.operator_ready_attestation is not None:
                if a.capture or a.closed_capture or a.fresh_app_opened:
                    raise ValueError('Choose operator attestation or capture epoch, not both')
                record = operator_epoch_record(launch, a.operator_ready_attestation)
            else:
                if not a.capture or not a.closed_capture or not a.fresh_app_opened:
                    raise ValueError('Capture epoch requires ordered captures and explicit fresh app confirmation')
                record = epoch_record(launch, a.closed_capture, a.capture)
            exclusive(Path(launch['directory']) / 'phases/epoch-confirmed.json', record)
            result = {'attempt': launch['attempt'], 'freshEpochRecorded': True}
    elif a.action == 'dispatch':
        credential = prompt_credential() if a.sudo else None
        try:
            result = dispatch(launch, a.phase, a.ssh_hostname, sudo=a.sudo, credential=credential)
        finally:
            credential = None
    elif a.action == 'confirm':
        result = confirm(launch, a.phase, a.capture, a.observed)
    elif a.action == 'status':
        result = live_control(launch)
    elif a.action == 'sample':
        result = live_control(launch, 'sample', label=a.label)
    elif a.action == 'mark-during':
        result = live_control(launch, 'mark', label='during', captureSha256=capture(a.capture)['sha256'])
    else:
        result = live_control(launch, 'stop')
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        print('Error: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
