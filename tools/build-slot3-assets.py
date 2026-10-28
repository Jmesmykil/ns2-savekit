#!/usr/bin/env python3
"""Reproduce the tested slot-3-only editor assets from separately fetched sources."""
import argparse
import hashlib
import importlib.util
import json
import sys
sys.dont_write_bytecode = True
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prepare_editor_slot', HERE / 'prepare-editor-slot.py')
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)
SOURCE_PINS = {'editor/build.py': 'd5e00d2540f4d520da675269d7f139273faaadf0c3c563b2d13d81f0691ffc28', 'editor/editor.lua': '655e5b6abbff4d44ee207228ff5b6c9f7d5bff963253e27689c7cd66f639f01a', 'editor/storage.lua': 'b149d9730e611aa084f7888b391032cd0ebe1a024dab7860e825a4a3d7d0c1a4', 'editor/transfer.lua': '841e896a4fe5efec0dbadf1c4c3b551bc2f5003f8fbe56d7e6f5e93254f86c11', 'editor/input.lua': '02a89ac22d7babd14db4d71fe4971d575e7dd5c9ff0dc7cb869c2f1af0b1141d', 'tools/asb.py': 'd54b2867430a4621127492e6536bc960b38c2dd13145b310f6e9fde81abca2ed', 'tools/indexed_save.py': '0e8b1cc818bbb362b1c587af45e08bba1f750bb800f758d34263d06c4a6e8092', 'tools/save_globals.py': 'ba952ccdcb1f7139681d2d01d18a4e426bc78b2945cc452baab10753da933409'}


def restrict_repair(source):
    before = b'local function repair()\n    local repaired=0\n    for i=1,3 do'
    after = b'local function repair()\n    local repaired=0\n    for i=3,3 do'
    if source.count(before) != 1:
        raise ValueError('Expected exactly one editor repair loop')
    source = source.replace(before, after, 1)
    return source


def build(upstream, release_dir, output):
    upstream = prep.no_symlinks(upstream)
    release_dir = prep.no_symlinks(release_dir)
    for name, expected in SOURCE_PINS.items():
        if prep.sha(prep.regular(upstream / name).read_bytes()) != expected:
            raise ValueError('Pinned editor source differs: ' + name)
    spec = importlib.util.spec_from_file_location('slot3_upstream_build', upstream / 'editor/build.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    source = builder.core_source()
    source = restrict_repair(source)
    boot = builder.bootstrap(3, zlib.adler32(source), '5b3750db')
    assets = {'ssedit3.lua': source, 'sed03.asb': boot, 'ssboot3.bin': boot}
    for name in ('save0003.dat', 'ssethumb.png'):
        assets[name] = prep.regular(release_dir / name).read_bytes()
    assets['ssseed003.bin'] = assets['save0003.dat']
    assets['save0003.png'] = assets['ssethumb.png']
    assets['save0003_s.png'] = assets['ssethumb.png']
    for name, expected in prep.SOURCE_HASHES.items():
        if prep.sha(assets[name]) != expected:
            raise ValueError('Generated asset differs from successful recipe: ' + name)
    output = prep.no_symlinks(output)
    for input_dir in (upstream, release_dir):
        if output == input_dir or input_dir in output.parents:
            raise ValueError('Output must be outside input directories')
    output.mkdir(mode=0o700, exist_ok=False)
    for name, data in assets.items():
        with (output / name).open('xb') as stream:
            stream.write(data)
    return {'files': [{'path': '/' + name, 'bytes': len(data), 'sha256': prep.sha(data)}
                      for name, data in sorted(assets.items())], 'hostBuildOnly': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', required=True, type=Path)
    parser.add_argument('--release-dir', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = build(args.upstream, args.release_dir, args.output)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, 'Build refused: ' + str(error) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
