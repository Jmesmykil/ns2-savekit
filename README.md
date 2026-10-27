# ns2-savekit

Save-data tooling for Switch 2, driven entirely over a live
[ns2jb](https://gitlab.com/kurumuz/ns2jb) RPC connection — plus the
save-launch payload system that turns a save file into Lua execution inside the
game process.

The exploit itself is **not** in this repository. We link to upstream rather than
vendor it, so this tree contains no exploit code, no keys, and no game content.

## What is proven, on hardware

Every claim below was executed on a retail Switch 2 with the demo and full game
installed, and the numbers are reproducible from the commands in
[docs/RESULTS.md](docs/RESULTS.md).

| Result | Evidence |
| --- | --- |
| Read another title's save through the promoted `pid=1` fsp-srv root | 70-file / 2.0 MB pull of `0100ee5021c9e000`, byte-verified |
| Write another title's save in one committed transaction | 275 files, 4,511,900 bytes, read back and hashed |
| Run arbitrary Lua inside a shipping Artemis game from save data alone | `ns2jb-report.txt` written by the game's own interpreter |
| Install a third-party save with no JKSV, no Switch 1, no Nintendo transfer | Seedsow Lua Editor v0.1.2 running from slot 1 |
| Full unsandboxed Lua 5.1 inside the game | `io`, `os`, `debug`, `package`, `loadstring`, `dofile` all present |

## The two mechanisms

**1. Save access (`tools/`).** The exploit hands us a session whose fsp-srv root
runs as `pid=1`. That root passes the save-data access check that a normal
application session fails with `FS 6400`, so we can open any whitelisted title's
save, read it, write new files into it, commit, and verify by re-reading.

**2. Save launch (`payloads/`, `tools/artemis-save.py`).** An Artemis slot save
records where execution resumes:

```
caret = { flags, ?, script-path, command-index, ?, ?, command-record }
```

Retarget `script-path` at `save:/name.asb` and the game resumes there instead of
its own script. `.asb` files are a plain-text Lua container (`ASB\0\0`, a command
count, then `lua` / `calllua` / `wait` / `stop` records), so a four-command file
puts our own chunk in front of the engine. The header names from
`system/table/list_switch.tbl` give a second, zero-edit entry point:
`save_prefix="save"` with `save_suspend=9999` makes the game look for
`save9999.dat` at boot and resume it — that file is the launcher, and the game
does not delete it when the caret has been retargeted.

## Safety model

Writes are the only dangerous operation, and they are fenced:

- **Read-only by default.** `save-pull-root.cjs` uses fsp-srv command 53 and
  never commits.
- **Disposable titles only.** A hard-coded whitelist; anything else is refused
  before a handle is opened.
- **Backup required.** Every write needs a prior pull directory; the target is
  compared against it before it is touched.
- **Add-only unless explicit.** New files are added; existing files may only be
  replaced when the manifest marks them and the live bytes still hash to the
  backup copy.
- **One transaction.** All files are written under a single open, one commit,
  then re-opened read-only and every file is hashed back.
- **Save-root only.** Paths must be `/name`; `..`, nested paths and absolute
  paths are rejected.

The promoted-root save path occasionally crashes the *host* application
(`2162-0002`, roughly 3 in 5 attempts on our unit). One save operation per boot,
and restart the console after a crash.

## Quick start

Two things are needed before anything else: an exploit session held open, and
this checkout. The exploit is not part of this repository - get it from
[ns2jb](https://gitlab.com/kurumuz/ns2jb) and keep it in its own directory.

```sh
# 1. Start the exploit and leave it running. It prints the run folder.
node run.cjs --rpc 192.168.50.34
#    -> Run folder: runs/switch2-XXXXXX
#    then, in a freshly opened SmileBASIC:
#      RUN
#      REMOVE NSR,&H60000000,&H3FFFFFFF
#      V=START(39380,192,168,50,34,0,0,0,0)

# 2. Drive everything else from the guided menu
node tools/kit.cjs
```

`kit.cjs` finds the newest held session (or takes one as an argument) and walks
the flow: list installed titles, pick one by number, enumerate its account uid,
pull a backup, and only then offer writes - each showing the exact file list and
asking for confirmation.

```
Which session?
  1) newest: switch2-XXXXXX
  2) switch2-YYYYYY   /path/to/runs/switch2-YYYYYY

What do you want to do?
  1) List installed titles
  2) List save archives known to FS
  3) Work on one title (backup, write, delete)
  4) Change session
  5) Quit
```

Inside a title:

```
1) Back up this save (needed before any write)
2) Write files from a manifest
3) Install the untethered launcher (Artemis)  <- needs a backup first
4) Install the Seedsow Lua Editor save
5) Delete a file
6) Back to the main menu
```

It is a front end, not a reimplementation: every action shells out to the tested
scripts in `tools/`, so the whitelist, the required backup, the verified replaces
and the single-commit write behave exactly as they were tested on hardware.

Requirements: `node` 20+, and `python3` for the manifest builders. If a run dies
at `2/4` with `console response timed out`, that is the exploit's timing lottery,
not the toolkit: close and reopen SmileBASIC and try again (the host keeps
waiting), and power-cycle the console if it fails twice in a row.

The individual scripts remain usable directly for scripting - see
`tools/save-pull-root.cjs`, `tools/save-write-stage.cjs` and the rest, whose
arguments are documented at the top of each file.


### What option 3 does

"Install the untethered launcher" builds four files from the backup you just
took and writes them in one transaction:

| file | what it is |
| --- | --- |
| `/ns2jb.asb` | stub ASB; runs the program named by `ssslot004.ref`, else `ns2jb.lua` |
| `/save9999.dat` | a copy of a real save with its caret retargeted at `save:/ns2jb.asb` |
| `/ns2jb.lua` | the body (editable on-console, <=32 chars per line) |
| `/sscode004.lua` | the same body as editor slot 4 |

The launcher blob comes from the backup's `autosave.dat`, or from its newest
`saveNNNN.dat` when the title never wrote an autosave (Nora only has slot 1).


## Install the Seedsow Lua Editor save

Requirements: `node` 20+, `python3`, `curl`, `unzip`, and a held ns2jb session
(`node run.cjs --rpc <computer-ip>` printing `Run folder: runs/switch2-XXXXXX`).

**Step 0 — the target save must already exist.** fsp-srv creates no save data;
the game does. Launch Seedsow Lullaby Demo once, get to the title screen, and
close it fully (**Home → X → Close**). Until you do, every attempt returns
`0x7d402` for all account/space/type combinations.

```sh
# 1. Which account owns the save? (16-byte AccountUid, printed as hex)
node tools/find-save-uid.cjs runs/switch2-XXXXXX 010042d022aea000

# 2. Back the save up (read-only) -- this is required before any write
node tools/save-pull-root.cjs runs/switch2-XXXXXX 010042d022aea000 saves/demo <uid>

# 3. Fetch the editor release (0BSD, from GitHub; nothing is bundled here)
./tools/fetch-editor-save.sh /tmp/seed

# 4. Build the install manifest: existing files become verified replaces,
#    everything else is add-only
python3 tools/build-editor-manifest.py /tmp/seed saves/demo staging/manifest.json

# 5. One transaction: open, write 275 files, commit, re-read and hash them all
node tools/save-write-stage.cjs runs/switch2-XXXXXX 010042d022aea000 <uid> \
     saves/demo staging/manifest.json
```

Boot the demo and choose **Load → slot 1**; the title of that slot reads
**LUA EDITOR V3** and the editor appears. Tested exactly this way on hardware:
275 files, 4,511,900 bytes, every hash identical to the release, no JKSV, no
Switch 1 and no Nintendo save transfer.

If step 5 reports `Directory exceeds the N-entry probe limit`, your copy is older
than the 2048-entry limit — raise it in `tools/save-pull-root.cjs` and
`tools/save-write-stage.cjs`.

## Next: untethered

See [docs/NEXT-STEPS.md](docs/NEXT-STEPS.md). The launcher already survives
reboots, so the only thing still tied to SmileBASIC is *getting bytes on and off
the console*. Splitting the payload into a stable boot stub plus an
editor-authored `ns2jb.lua` removes the last PC from the loop.

Status of that split, so nobody has to guess:

- `payloads/ns2jb-stub.lua` (loads `save:/ns2jb.lua`), `payloads/ns2jb.lua`
  (body), and `tools/build-untethered.sh` (builds all three files from a backup)
  are written and pass a local smoke test with a mock engine.
- They are **not yet installed on hardware**. What is proven on hardware is the
  single-file launcher (`ns2jb.asb`) running Lua at boot, and the editor install.
- Until the stub is installed, editing the payload still means rewriting
  `ns2jb.asb` from a host with a held session.

## Credits

- **[Seedsow Lua Editor](https://github.com/DialingSpoon527/seedsow-lua-editor)** by
  [DialingSpoon527](https://github.com/DialingSpoon527) — BSD Zero Clause (0BSD).
  This project would not exist without it: its save format notes and
  `tools/asb.py` / `tools/indexed_save.py` are the basis for
  `tools/artemis-save.py`, and its released save is what we install to prove the
  write path end to end. The save itself is **downloaded from their release**,
  never bundled here — see `tools/fetch-editor-save.sh`. If you want to run Lua
  on the console with a proper editor UI, use their project.
- **[ns2jb](https://gitlab.com/kurumuz/ns2jb)** (kurumuz) — the exploit that gives
  the held session every tool here talks to. Not vendored; fetched from upstream.
- **Artemis engine** — no code or assets included; no affiliation.

## Layout

```
tools/     save pull/write/list/enumerate, ASB encoder, caret patcher, FTP mirror
payloads/  Lua that runs inside the game: bootstrap probe, capability probe, env map + pluto fuzz
docs/      results, next steps, CMIF pointer buffers, save-launch notes
tests/     offline round-trip and manifest tests (do not prove console behaviour)
```

## Licence and third parties

Our code is MIT (see [LICENSE](LICENSE)). Third-party components and links are
listed in [NOTICE](NOTICE): ns2jb (upstream exploit, linked), Seedsow Lua Editor
(0BSD, its save is fetched, not bundled), and the Artemis engine itself (no
affiliation).
