# Established SmileBASIC host route

This prepares the fixed filesystem prefix used for the successful slot 3 install.
The portable wrapper has offline coverage. It has not had a fresh console test.
Keep the generated package, pairing values and backups private.

## Dependencies

The pinned ns2jb revision's published prerequisites are Switch 2 system software
23.0.1, SmileBASIC 4.4.9 (its demo is also supported upstream), Node 22 or newer on
macOS/Linux, over 20 MiB free in the SmileBASIC save, Ethernet on both the computer
and console, and both applications installed on internal storage. This states
the dependency's qualification requirements; it does not establish a console
result for the portable wrapper. Filesystem acquisition timing remains unstable.

Also use Python 3.10 or newer, Git, an existing trusted SSH connection to the
keyboard Pi, and a configured full-speed USB keyboard gadget. Close Seedsow
before accessing its save. Preserve the working keyboard wiring. The generated
package checks the source and the Pi before input.

From this checkout, prepare separate dependency directories:

```sh
git clone https://gitlab.com/kurumuz/ns2jb ../ns2jb-route
git -C ../ns2jb-route checkout --detach 81d5bb114c856109dadaf1077d927a9f297fe58d
for patch in "$PWD"/patches/*.diff; do
  git -C ../ns2jb-route apply --3way "$patch" || exit 1
done
git clone https://github.com/Jmesmykil/pi4-switch-input ../pi4-switch-input
git -C ../pi4-switch-input checkout --detach cb238e0cc7259354cf0fe8724016c684b6bca961
```

Use the Pi input project's README to prepare the gadget if needed. Preserve an
existing working gadget. Its `status` must show one controller, `configured` and
`full-speed`. Read its actual serial and serial-file path into the configuration.
For that public gadget, these are `PI4-SWITCH-KEYBOARD-1` and
`/sys/kernel/config/usb_gadget/pi4_switch_keyboard/strings/0x409/serialnumber`.

## Configure and prepare

```sh
mkdir -m 700 private
cp tools/established-route/config.example.json private/route.private.json
```

Edit every example value. `host` is the computer's wired LAN IPv4 address, which
the console must reach. `sshConfig`, `sshAlias`, `sshHostKeyAlias` and `piHostname`
identify the existing trusted Pi connection. `remoteInputRoot` is the Pi directory
holding `pi_hid_type.py`. `usbSerial`, `serialPath` and `hidDevice` identify the
existing keyboard. Use an SSH config with `StrictHostKeyChecking yes` and the
configured `HostKeyAlias`. The sender also forces both options on its SSH command.

```sh
python3 tools/established-route/prepare.py \
  --ns2jb ../ns2jb-route \
  --keyboard-source ../pi4-switch-input/pi_hid_type.py \
  --config private/route.private.json --output private/host
```

Save the printed `packageSHA256` as `PACKAGE_SHA`. This offline command checks all
90 engine files, reconstructs the paired bootstrap and transport, and retrieves
the historical pull and write tools from this repository's retained Git history.
Use a full clone; a shallow clone may lack that history. A pin mismatch stops
preparation. The command refuses an existing output directory.

Install `private/host/keyboard/pi_hid_type.py` on the Pi at the configured
`remoteInputRoot/pi_hid_type.py`. The prepared file is the exact historical encoder,
SHA-256 `a0a0e5376586367cac4875038e969515f4922e1f07fb63b87e94a07cdfca9f8c`.
The reconstruction patch reverses the public encoder's later report-length guard
and optional `main(argv)` interface; the successful sender uses its existing
`plan` and `send` functions and eight-byte keyboard reports.

On the Pi, create `hb-attempts` under that input directory with mode 700 and a
regular `hb-attempts/session.lock` file. The privileged sender needs read/write
access there and to the configured HID device. It refuses a symlinked ledger.
Copy the prepared encoder through the existing trusted SSH connection; do not
replace the gadget or alter its speed during a session.

## Save the paired bootstrap once

Save the exact text from `private/host/core/sources/bootstrap.bas` into SmileBASIC
as `TXT:NS2GOOD`. This version has nine START arguments, including four fresh
pairing values. The stock five-argument bootstrap cannot connect to this host.
Its source SHA-256 is
`2261f65fb9ec0ed708ce0f0b6da5057168f706e541d956f658a3c2655e9e8c36`.

To enter it through the configured keyboard, copy that file to the Pi. Open an
empty SmileBASIC program editor, place the cursor at its first line, then run on
the Pi:

```sh
sudo python3 /path/to/input/pi_hid_type.py \
  --file /path/to/bootstrap.bas --caps-mode upper-default --progress-lines
```

The file sender expects SmileBASIC's carried indentation. Inspect the program,
return to Direct, and save it with `SAVE "TXT:NS2GOOD"`. Reopen it to check the
nine-argument START definition before continuing. Input delivery and local source
hashes do not authenticate the saved console bytes. This is a setup prerequisite.

## Start one fresh session

Use a fresh normal console boot for each write phase in the README. After
creating the attempt below, capture the app-closed screen and then fresh
SmileBASIC Direct as two ordered PNG files. Use real captures from this attempt.

```sh
python3 private/host/core/phase.py preflight --sudo --ssh-hostname PI_HOSTNAME
node private/host/core/host.cjs --prepare --preflight-receipt PREFLIGHT_RECEIPT
```

Use the printed absolute attempt directory as `ATTEMPT`. The preflight receipt
expires after two minutes. In terminal 1, leave this running:

```sh
node private/host/live/start.cjs ATTEMPT PACKAGE_SHA
```

In terminal 2, record the fresh app epoch and send the established sequence:

```sh
python3 private/host/core/phase.py --attempt ATTEMPT epoch \
  --fresh-app-opened --closed-capture CLOSED.png --capture DIRECT.png
python3 private/host/live/live-preflight/run-established-bootstrap.py ATTEMPT PI_HOSTNAME
python3 private/host/control.py --attempt ATTEMPT status
```

The sender executes LOAD `TXT:NS2GOOD`, Right then keyboard A, RUN, REMOVE, and
the fresh nine-argument START command. It pauses 3 seconds after LOAD and its
confirmation, 8 after RUN, and 2 after REMOVE and START. It records each phase
once, then requires fresh native qualification with scratch and import restored.

Only then does it request this fixed prefix:

```text
app/map → app/inspect-mounts → app/qualify → acquire
→ retained/find-metadata → ro/install-retained → ro/layout → ro/objects:root
```

Wait for `FS_ROOT_READY`, `busy=false`, and owned native/filesystem state. Each
stage has a 600000 ms deadline. A timeout or uncertain phase consumes the attempt;
do not retry it or reuse its pairing. This route never invokes the broader
`switch2/pipeline.cjs`. The scoped bridge uses a fresh bearer token, and its RPC
client carries that token. Its listener is local to the computer.

The savekit run argument is `ATTEMPT/seedsow-engine`. Use the generated
`private/host/savekit/save-pull-root.cjs` and `save-write-stage.cjs`, pinned to
savekit `856b6c4145bd2075815527327b120186017afca3`, with the staged workflow in
the main README. Keep terminal 1 running during those operations.

## Release before opening Seedsow

Wait for the save tool to finish and its commit/readback checks to pass. Then:

```sh
python3 private/host/control.py --attempt ATTEMPT release-fs
python3 private/host/control.py --attempt ATTEMPT stop
```

The release waits for owned resources to retire and filesystem ownership to
become false. Normal stop must report `CLOSED`. A terminal or busy session refuses
cleanup replay and cannot claim a clean close. Preserve its records and stop
there. Open Seedsow only after the successful release and normal close.

The historical final write replaced two files, preserved 43 other files, and
opened the editor from slot 3 before and after one normal restart. Those results
describe the recorded run. Offline tests of this portable package do not replace
a console test of the new package.
