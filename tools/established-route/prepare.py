#!/usr/bin/env python3
"""Prepare a private source-pinned host package. This command stays offline."""
import argparse
import hashlib
import ipaddress
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
KIT = ROOT.parents[1]
SAVEKIT_REVISION = '856b6c4145bd2075815527327b120186017afca3'
TRANSPORT = {
    'bootstrap.bas': ('bootstrap.bas', 'dca34ac7977cfd3f7cb657a79da925450472b6527ea83d022a9aa25510b168d5'),
    'connection.cjs': ('engine/lib/connection.cjs', '8967986f113b9d80e0b6f5b2f5cb413fd69e9ef4f866627df2c8d4189fb3ee2f'),
    'native.cjs': ('engine/lib/native.cjs', '6c95f441331501b9c549f9bd7fc24f6993b32dd4e265ebe71160d679c6aecbc6'),
    'qualify.cjs': ('engine/lib/qualify.cjs', '78ae0842170f7837e4a1ca46efd00fc4be1bfe68987a71717debc51a38a6ee7c'),
}
PAIRED = {
    'bootstrap.bas': '2261f65fb9ec0ed708ce0f0b6da5057168f706e541d956f658a3c2655e9e8c36',
    'connection.cjs': '4e4c9eebfc2b0a4bc4b66f783b9f7ef2ac8e29379376956c4d4267a50433b9a1',
}
SAVE_TOOLS = {
    'save-pull-root.cjs': 'a925b493f669c99f67c8cce0be766fe1ca72af4a4e7806e296467ff1e9451036',
    'save-write-stage.cjs': 'b93daae795ebe5128127f81ed0dc311974cb1116e942a1add34f093411e2436e',
}
ENCODER = 'a0a0e5376586367cac4875038e969515f4922e1f07fb63b87e94a07cdfca9f8c'
PUBLIC_ENCODER = '1afbb46f60e5eee9f320c0f9125a4694b83e8fc8f1a79b85c260ec7cecadd4c0'
RPC_BEFORE = 'c2a30110d8303d9403f58683d0b8ba8e71b35a6b140682ee9e065e9c370e9257'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(file):
    file = Path(file).absolute()
    for parent in (file, *file.parents):
        if parent.is_symlink():
            raise ValueError('Symlink path refused: ' + str(parent))
    if not file.is_file():
        raise ValueError('Regular file required: ' + str(file))
    return file


def private_write(file, data):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with file.open('xb') as stream:
        os.chmod(file, 0o600)
        stream.write(data)


def dump(value):
    return (json.dumps(value, indent=2) + '\n').encode()


def configuration(file):
    config = json.loads(regular(file).read_bytes())
    required = {'host', 'port', 'sshConfig', 'sshAlias', 'sshHostKeyAlias',
                'piHostname', 'remoteInputRoot', 'usbSerial', 'hidDevice', 'serialPath'}
    if set(config) != required:
        raise ValueError('Config keys must be: ' + ', '.join(sorted(required)))
    if not isinstance(config['host'], str):
        raise ValueError('Host must be a wired LAN IPv4 string')
    address = ipaddress.ip_address(config['host'])
    if address.version != 4 or address.is_unspecified or address.is_multicast or address.is_loopback:
        raise ValueError('Use the wired host LAN IPv4 address')
    if type(config['port']) is not int or not 1024 <= config['port'] <= 65535:
        raise ValueError('Port must be 1024..65535')
    for field in required - {'host', 'port'}:
        value = config[field]
        if not isinstance(value, str) or not value or any(c in value for c in '\n\r\x00'):
            raise ValueError('Invalid config field: ' + field)
    for field in ('sshAlias', 'sshHostKeyAlias', 'piHostname'):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', config[field]) or config[field].startswith('-'):
            raise ValueError('Invalid SSH name: ' + field)
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', config['usbSerial']):
        raise ValueError('USB serial must be an existing plain gadget identifier')
    for field in ('sshConfig', 'remoteInputRoot', 'hidDevice', 'serialPath'):
        if not Path(config[field]).is_absolute() or '..' in Path(config[field]).parts:
            raise ValueError('Absolute path required: ' + field)
    ssh = regular(config['sshConfig']).read_text()
    if 'StrictHostKeyChecking yes' not in ssh or ('HostKeyAlias ' + config['sshHostKeyAlias']) not in ssh:
        raise ValueError('Existing SSH config must use strict host keys and the configured alias')
    return config


def render(text, config):
    fields = {'HOST': config['host'], 'SSH_CONFIG': config['sshConfig'],
              'SSH_HOST_KEY_ALIAS': config['sshHostKeyAlias'], 'SSH_ALIAS': config['sshAlias'],
              'USB_SERIAL': config['usbSerial'], 'REMOTE_INPUT_ROOT': config['remoteInputRoot'],
              'HID_DEVICE': config['hidDevice'], 'SERIAL_PATH': config['serialPath']}
    for name, value in fields.items():
        # Replace complete string literals, retaining each language's quoting.
        text = text.replace("'__" + name + "__'", repr(value))
    # The SSH trust marker also occurs inside a longer Python string literal.
    text = text.replace('__SSH_HOST_KEY_ALIAS__', config['sshHostKeyAlias'])
    text = text.replace('__PORT__', str(config['port']))
    text = text.replace('__HOST_OCTETS__', repr([int(x) for x in config['host'].split('.')]))
    endpoint = ','.join([str(config['port']), *config['host'].split('.')])
    text = text.replace('__START_ENDPOINT_REGEX__', re.escape(endpoint))
    return text


def source_inputs(ns2jb):
    ns2jb = Path(ns2jb).absolute()
    pins = json.loads((ROOT / 'engine-pins.json').read_bytes())
    files = {}
    if len(pins['files']) != 90:
        raise ValueError('Expected the ninety-file established engine source set')
    for record in pins['files']:
        relative = Path(record['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe engine source path')
        data = regular(ns2jb / 'engine' / relative).read_bytes()
        if record['path'] == 'shared/rpc.cjs' and sha(data) == RPC_BEFORE:
            before = b"const {port, addresses} = require('../connection.json');"
            after = b"const {port, token, addresses} = require('../connection.json');"
            header = b"headers: {'content-type': 'application/json'}"
            if data.count(before) != 1 or data.count(header) != 1:
                raise ValueError('Unexpected RPC bearer patch context')
            data = data.replace(before, after).replace(header, b"headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'}")
        if len(data) != record['bytes'] or sha(data) != record['sha256']:
            raise ValueError('Engine source pin differs: ' + record['path'])
        files['engine-source/' + record['path']] = data
    for name, (relative, digest) in TRANSPORT.items():
        data = regular(ns2jb / relative).read_bytes()
        if sha(data) != digest:
            raise ValueError('Transport source pin differs: ' + relative)
        files['core/sources/' + name] = data
    # Reconstruct the historical tools from the fork's retained upstream history.
    for name, digest in SAVE_TOOLS.items():
        data = subprocess.check_output(['git', '-C', str(KIT), 'show',
                                        SAVEKIT_REVISION + ':tools/' + name], stderr=subprocess.PIPE)
        if sha(data) != digest:
            raise ValueError('Historical save tool pin differs: ' + name)
        files['savekit/' + name] = data
    return pins, files


def prepare(ns2jb, config_file, output, keyboard_source):
    config = configuration(config_file)
    pins, inputs = source_inputs(ns2jb)
    keyboard = regular(keyboard_source).read_bytes()
    keyboard_digest = sha(keyboard)
    if keyboard_digest not in (ENCODER, PUBLIC_ENCODER):
        raise ValueError('Keyboard source pin differs from the historical or published encoder')
    inputs['keyboard/pi_hid_type.py'] = keyboard
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError('Output already exists; a used package is never overwritten')
    for parent in output.parents:
        if parent.is_symlink():
            raise ValueError('Symlink output parent refused')
    output.mkdir(parents=False, mode=0o700)
    for relative, data in inputs.items():
        private_write(output / relative, data)
    if keyboard_digest == PUBLIC_ENCODER:
        subprocess.run(['git', 'apply', '--directory=keyboard', str(ROOT / 'keyboard-historical.diff')],
                       cwd=output, check=True, capture_output=True)
    if sha((output / 'keyboard/pi_hid_type.py').read_bytes()) != ENCODER:
        raise ValueError('Historical keyboard reconstruction differs')
    subprocess.run(['git', 'apply', '--directory=core', str(ROOT / 'transport-pairing.diff')],
                   cwd=output, check=True, capture_output=True)
    for name, digest in PAIRED.items():
        if sha((output / 'core/sources' / name).read_bytes()) != digest:
            raise ValueError('Paired transport reconstruction differs: ' + name)
    manifest = {'runtime_JSON_copied': False, 'connection_metadata_present': False,
                'JSON_allowlist': pins['JSON_allowlist'], 'destination': str(output / 'engine-source'),
                'files': pins['files']}
    manifest_bytes = dump(manifest)
    template_hash = sha(manifest_bytes)
    private_write(output / 'live/live-preflight/engine-source-manifest.json', manifest_bytes)
    templates = ROOT / 'templates'
    rendered = {str(file.relative_to(templates)): render(file.read_text(), config)
                for file in templates.rglob('*') if file.is_file()}
    helper_hash = sha(rendered['live/live-preflight/remote-community-phase.py'].encode())
    for relative, text in rendered.items():
        text = text.replace('__TEMPLATE_MANIFEST_SHA256__', template_hash).replace('__COMMUNITY_HELPER_SHA__', helper_hash)
        if re.search(r'__[A-Z][A-Z_]+__', text):
            raise ValueError('Unresolved configuration field in ' + relative)
        private_write(output / relative, text.encode())
    private_write(output / 'core/route-config.private.json', dump(config))
    source_records = [{'copy': 'sources/' + name, 'sha256': sha((output / 'core/sources' / name).read_bytes())}
                      for name in TRANSPORT]
    private_write(output / 'core/ownership.json', dump({'purpose': 'single-use-savekit-route', 'sources': source_records}))
    entries = [{'path': str(file.relative_to(output)), 'sha256': sha(file.read_bytes())}
               for file in sorted(output.rglob('*')) if file.is_file()]
    lock = dump({'schema': 1, 'files': entries,
                  'historicalHardwareRoute': True, 'portablePackageHardwareTested': False,
                  'stageDeadlineMs': 600000, 'encoderSHA256': ENCODER})
    private_write(output / 'package-lock.json', lock)
    return {'package': str(output), 'sourceFiles': 90, 'listenerStarted': False,
            'deviceContacted': False, 'portablePackageHardwareTested': False,
            'packageSHA256': sha(lock)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ns2jb', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--keyboard-source', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.ns2jb, args.config, args.output, args.keyboard_source), indent=2))
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, 'Preparation refused: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
