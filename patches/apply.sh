#!/bin/sh
# Apply the engine patches to an ns2jb checkout.
#   sh patches/apply.sh /path/to/ns2jb
set -eu
target=${1:?usage: apply.sh <ns2jb-checkout>}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for patch in "$here"/0001-*.diff "$here"/0002-*.diff; do
  echo "applying $(basename "$patch")"
  git -C "$target" apply -3 "$patch"
done
node --check "$target/engine/shared/ipc.cjs"
node --check "$target/engine/switch2/app/mounted-save.cjs"
echo "patched and syntax-checked: $target"
