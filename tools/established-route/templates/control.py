#!/usr/bin/env python3
"""Status, owned filesystem release, and normal host close for one attempt."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent / 'core'))
import phase


def control(attempt, action, timeout=600):
    launch = phase.load_launch(attempt)
    before = phase.live_control(launch)
    if action == 'status':
        return before
    if before.get('terminal') or before.get('busy'):
        raise ValueError('Host is terminal or busy; no cleanup replay is allowed')
    if action == 'stop':
        if before.get('state') != 'QUALIFIED' or before.get('filesystemOwnership') is not False:
            raise ValueError('Release known filesystem ownership before normal stop')
        reply = phase.live_control(launch, 'stop')
        if reply.get('state') != 'CLOSED' or reply.get('result', {}).get('closed') is not True:
            raise ValueError('Normal close was not confirmed')
        return reply
    if action != 'release-fs' or before.get('state') != 'FS_ROOT_READY':
        raise ValueError('Only a known idle filesystem root can be released')
    phase.live_control(launch, 'release-fs')
    deadline = time.monotonic() + timeout
    while True:
        reply = phase.live_control(launch)
        if reply.get('terminal'):
            raise ValueError('Release ended uncertain; do not retry or claim CLOSED')
        if reply.get('state') == 'QUALIFIED' and reply.get('filesystemOwnership') is False and not reply.get('busy'):
            return reply
        if time.monotonic() >= deadline:
            raise TimeoutError('Release deadline expired; outcome remains unknown')
        time.sleep(.25)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--attempt', required=True, type=Path)
    parser.add_argument('action', choices=['status', 'release-fs', 'stop'])
    args = parser.parse_args()
    try:
        print(json.dumps(control(args.attempt, args.action), indent=2))
    except (ValueError, OSError, KeyError, TimeoutError) as error:
        parser.exit(1, 'Control refused: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
