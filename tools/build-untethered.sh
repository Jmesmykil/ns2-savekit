#!/bin/sh
# Build the untethered launcher set for one save:
#   ns2jb.asb     stub ASB that loads save:/ns2jb.lua
#   ns2jb.lua     body, editable on the console
#   save9999.dat  suspend launcher resuming at save:/ns2jb.asb
#   manifest.json for tools/save-write-stage.cjs
#   ./tools/build-untethered.sh <backup-directory> <output-directory>
set -eu
base=${1:?usage: build-untethered.sh <backup-directory> <output-directory>}
out=${2:?usage: build-untethered.sh <backup-directory> <output-directory>}
here=$(dirname "$0")
mkdir -p "$out"
python3 "$here/artemis-save.py" asb "$here/../payloads/ns2jb-stub.lua" ns2jb_boot "$out/ns2jb.asb"
cp "$here/../payloads/ns2jb.lua" "$out/ns2jb.lua"
python3 "$here/artemis-save.py" launch "$base/autosave.dat" ns2jb.asb "$out/save9999.dat"
python3 - "$out" <<'PY'
import json, sys
out = sys.argv[1]
json.dump({'title': 'Seedsow Lullaby demo -- untethered launcher',
           'purpose': 'boot stub + on-console body + suspend launcher',
           'files': [{'path': '/ns2jb.asb', 'local': out + '/ns2jb.asb'},
                     {'path': '/ns2jb.lua', 'local': out + '/ns2jb.lua'},
                     {'path': '/save9999.dat', 'local': out + '/save9999.dat'}]},
          open(out + '/manifest.json', 'w'), indent=2)
PY
echo "built $out/manifest.json"
