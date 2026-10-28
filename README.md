# ns2-savekit: SmileBASIC to Seedsow

This fork preserves the route used to install Seedsow Lua Editor in **Seedsow
Lullaby Demo slot 3**, keeping the personal slot 1 save. It adds pinned host
preparation, guarded staging and checked backup/write wrappers to
[dougchansan/ns2-savekit](https://github.com/dougchansan/ns2-savekit).

The recorded final write replaced 2 files in a 45-file backup; the other 43
matched. Slot 3 opened the editor before and after one normal console restart.
Those are historical results. **This portable fork is validated offline and has
not been run on a console.** Host tests cannot guarantee a live session's result.

## Requirements and sources

The pinned ns2jb source publishes these prerequisites: Switch 2 system software
**23.0.1**, **SmileBASIC 4.4.9** (the demo is also supported upstream), **Node 22+**
on macOS/Linux, over **20 MiB free in the SmileBASIC save**, Ethernet on **both the
computer and console**, and the game and SmileBASIC installed on **internal
storage**. These are upstream qualification requirements, not fresh hardware
qualification of this portable fork. Acquisition timing remains unstable.

Also use Python 3.10+, Git, curl, unzip, the existing full-speed Pi USB keyboard
with trusted SSH access, and Seedsow Lullaby Demo `010042D022AEA000`. This route
targets that demo only. Keep personal saves and backups. Begin with slot 3 unused;
the prerequisite stage refuses existing slot 3/editor assets.

Use a full clone of this fork: historical save tools are recovered from retained
Git history. Create a new private work folder outside the checkout:

```sh
git clone https://github.com/Jmesmykil/ns2-savekit.git
cd ns2-savekit
SAVEKIT_WORK="$HOME/seedsow-transfer-private"
mkdir -m 700 "$SAVEKIT_WORK"
git clone https://github.com/DialingSpoon527/seedsow-lua-editor "$SAVEKIT_WORK/editor-source"
git -C "$SAVEKIT_WORK/editor-source" checkout --detach d893e99c6ccc83a4dbe85c8c0c902bc8f7f01e46
sh tools/fetch-editor-save.sh "$SAVEKIT_WORK/editor-release" v0.1.2
python3 tools/build-slot3-assets.py \
  --upstream "$SAVEKIT_WORK/editor-source" \
  --release-dir "$SAVEKIT_WORK/editor-release" --output "$SAVEKIT_WORK/editor-assets"
```

The builder verifies source/output hashes. Its only editor change limits the
repair loop from slots 1–3 to slot 3 and regenerates the bootstrap checksum. All
eight outputs matched the recorded stage byte for byte. It does not modify the
downloaded source or bundle game saves.

Follow [Host setup](docs/ESTABLISHED-ROUTE.md) for the pinned ns2jb/Pi clones,
patches, SSH configuration, keyboard deployment and bootstrap entry. Copy
`tools/established-route/config.example.json` to `$SAVEKIT_WORK/route.private.json`
and replace every value with the actual wired host and existing keyboard details.
Then prepare offline:

```sh
python3 tools/established-route/prepare.py \
  --ns2jb ../ns2jb-route --keyboard-source ../pi4-switch-input/pi_hid_type.py \
  --config "$SAVEKIT_WORK/route.private.json" --output "$SAVEKIT_WORK/host"
```

Keep the printed `packageSHA256`. Install the generated historical encoder on the
Pi and save the generated paired bootstrap as `TXT:NS2GOOD` exactly as described
in Host setup. Local hashes do not authenticate the program saved on the console.
Keep generated hosts, captures, identities and backups private.

## The order that worked

**Each phase requires a fresh normal console boot, new SmileBASIC session,
new filesystem root and fresh backup.** One phase contains one backup and one
guarded write. Nothing retries automatically.

| Phase | Files staged | Next action after release/close |
| --- | --- | --- |
| `baseline` | 4: `ns2jb.asb`, `save9999.dat`, `ns2jb.lua`, `sscode004.lua` | Open the demo and check the saved-launcher marker. |
| `prerequisites` | 8 slot-3 assets added, temporary `ns2jb.lua` replaced | Open the game and **make a normal game save in slot 3**. Confirm its visible card. |
| `correction` | Only `save0003.dat` and `ns2jb.lua` replaced | Load slot 3, then repeat after a normal restart. |

The temporary registration alone left slot 3 showing `NO DATA`. The normal game
save registered the slot. The correction preserved native metadata, installed the
editor data and restored the original boot body. Do not skip that native save or
reuse the earlier backup. Leave slot 1 untouched.

## Acquire a fresh session for one phase

Close Seedsow and normally restart the console. Replace the quoted placeholders
below with the actual configured hostname and values printed by the tools.

```sh
SAVEKIT_PI='your-configured-pi-hostname'
SAVEKIT_PACKAGE_SHA='the-64-hex-packageSHA256-printed-during-preparation'
python3 "$SAVEKIT_WORK/host/core/phase.py" preflight --sudo --ssh-hostname "$SAVEKIT_PI"
node "$SAVEKIT_WORK/host/core/host.cjs" --prepare --preflight-receipt '/absolute/printed/preflight-receipt.json'
SAVEKIT_ATTEMPT='/absolute/attempt/directory/printed/by/host'
```

In terminal 1, leave the host running:

```sh
node "$SAVEKIT_WORK/host/live/start.cjs" "$SAVEKIT_ATTEMPT" "$SAVEKIT_PACKAGE_SHA"
```

In terminal 2, use two real, ordered PNG captures taken **after this attempt was
created**: the app closed, then freshly reopened SmileBASIC Direct.

```sh
python3 "$SAVEKIT_WORK/host/core/phase.py" --attempt "$SAVEKIT_ATTEMPT" epoch \
  --fresh-app-opened --closed-capture '/absolute/path/app-closed.png' \
  --capture '/absolute/path/fresh-direct.png'
python3 "$SAVEKIT_WORK/host/live/live-preflight/run-established-bootstrap.py" "$SAVEKIT_ATTEMPT" "$SAVEKIT_PI"
python3 "$SAVEKIT_WORK/host/control.py" --attempt "$SAVEKIT_ATTEMPT" status
```

The sender chains LOAD → Right/A → RUN → REMOVE → fresh paired START, then
requires native qualification before the fixed filesystem prefix. Wait for
`FS_ROOT_READY`, `busy=false` and owned native/filesystem state. Pairing expires
after 9 minutes; each filesystem stage has a separate 600000 ms deadline.
[Host setup](docs/ESTABLISHED-ROUTE.md) gives the exact prefix and failure rules.

## Back up, stage and write

Use the correct account's raw 16-byte UID as 32 hex digits, without integer or
endianness conversion. If unknown, use a **separate discovery session** and run:

```sh
SAVEKIT_RUN="$SAVEKIT_ATTEMPT/seedsow-engine"
node "$SAVEKIT_WORK/host/savekit/save-pull-root.cjs" "$SAVEKIT_RUN" \
  010042D022AEA000 "$SAVEKIT_WORK/unused-account-query-output" --list-uids
```

This account query does not mount a game save. Choose the intended account;
never guess between multiple accounts. Release/close discovery, then obtain a
fresh session for the actual phase.

For the actual phase, set `baseline` first, then `prerequisites`, then
`correction` on their respective fresh sessions. Run each command only after its
predecessor succeeds; output folders must be new:

```sh
SAVEKIT_PHASE='baseline'
SAVEKIT_RAW_UID='the-correct-32-hex-raw-account-UID'
SAVEKIT_RUN="$SAVEKIT_ATTEMPT/seedsow-engine"
python3 tools/record-save-backup.py --run "$SAVEKIT_RUN" --uid "$SAVEKIT_RAW_UID" \
  --pull-tool "$SAVEKIT_WORK/host/savekit/save-pull-root.cjs" \
  --output "$SAVEKIT_WORK/backup-$SAVEKIT_PHASE"
python3 tools/prepare-editor-slot.py --phase "$SAVEKIT_PHASE" \
  --backup-manifest "$SAVEKIT_WORK/backup-$SAVEKIT_PHASE/manifest.json" \
  --editor-dir "$SAVEKIT_WORK/editor-assets" --output "$SAVEKIT_WORK/stage-$SAVEKIT_PHASE"
python3 tools/write-prepared-stage.py --run "$SAVEKIT_RUN" \
  --writer "$SAVEKIT_WORK/host/savekit/save-write-stage.cjs" \
  --manifest "$SAVEKIT_WORK/stage-$SAVEKIT_PHASE/manifest.json"
```

The backup wrapper checks a successful pinned pull, full mounted UID, listing,
sizes and two host reads, then generates the inventory. Device provenance is
**not authenticated**. Optional `--save-id` is descriptive caller metadata;
selection uses the fixed demo title and raw UID.

The writer wrapper derives identity/paths, rechecks the same phase plan, validates
run/session binding and all hashes, and reserves one write. Success requires
commit `0x0`, every staged file's full-hash success tag from the pinned writer,
and matching readback of every untouched original. Exit zero alone is insufficient.
Missing, extra, duplicate or mismatched results are failures; logs are retained.

## Release, then check the game

After `complete: true` from the write wrapper:

```sh
python3 "$SAVEKIT_WORK/host/control.py" --attempt "$SAVEKIT_ATTEMPT" release-fs
python3 "$SAVEKIT_WORK/host/control.py" --attempt "$SAVEKIT_ATTEMPT" stop
```

Require filesystem ownership false and host `CLOSED` before opening Seedsow.
After baseline, check the marker. After prerequisites, enter the normal game,
save in slot 3 and confirm its card. Close the game, restart, acquire a fresh
session/backup, then perform correction. Load the top-right slot 3 and confirm
the editor appears. Restart normally and load the same slot again. Record visible
results separately from committed-file hashes.

On timeout, uncertain input, failed acquisition or readback failure, stop and
preserve the attempt. Do not replay pairing, repeat consumed operations, force
cleanup or claim a clean close. Obtain a reviewed recovery before another run.

## Offline checks and attribution

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_established_route.cjs
```

Fixtures use synthetic saves, temporary files, fake Node processes and controlled
host interfaces. Tests do not connect to a console. See [fork guards](docs/FORK.md)
and [original upstream documentation](docs/UPSTREAM-README.md). The original MIT
license and history remain. Seedsow Lua Editor is DialingSpoon527's separate 0BSD
project; game saves, keys, console dumps and private session data are not bundled.
