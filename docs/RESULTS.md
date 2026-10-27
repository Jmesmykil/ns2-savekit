# Results

Everything here was run on a retail Switch 2 (system software with the microSD
Express support update, item 3 = **(B)**) against the installed Seedsow Lullaby
demo (`010042d022aea000`) and full game (`0100ee5021c9e000`), plus Nintendo
Switch Sports Resort (`04008e001f098000`). Nothing was emulated.

## Save access

| Action | Observed |
| --- | --- |
| Enumerate installed titles over the held session | 9 applications, `BuiltInUser` |
| Open a save that does not exist yet | `0x7d402` for all 3 accounts × 4 spaces × 2 types |
| Open an existing save | `space=User type=Account uid=539fd277…3664 -> ok` |
| Pull full game save | 70 files, 1,993,280 bytes |
| Pull again later (state changed) | 73 files, 2,021,377 bytes |
| Pull demo save after first launch | 9 files, 183,959 bytes |
| Pull save with 275 installed files | 275 files, 4,511,900 bytes |

`0x7d402` is the "no save data" answer, not "in use": a title that has never been
launched reports it for every combination, and it changes to `ok` once the game
creates its save.

## Save launch (Lua inside the game)

Payload v1, installed with the caret retarget `system/ui.asb` → `save:/ns2jb.asb`,
command index `4` → `1`, six event-handler names cleared. Boot produced a **black
screen**, and the pull afterwards returned:

```
/ns2jb-report.txt (1155 bytes)
/save9999.dat     (23367 bytes)   ← still present, not consumed
/ns2jb.asb        (3887 bytes)
```

Report contents (abridged):

```
ns2jb=Lua from save data is running
lua=Lua 5.1
io=table os=table debug=table package=table
os.execute=function io.popen=function debug.sethook=function package.loadlib=function
s.savepath=save:
s.datapath=game:
engine.type=userdata  engine.mt.__index=function
```

So: arbitrary Lua in the shipping game, entered from a save file, with the
engine's own handle. `save9999.dat` surviving means the launcher is not one-shot —
the engine's delete step only runs on its internal suspend path.

Payload v2 added capability probes and an exit through
`jump system/first.iet label="title"`. Boot: black, then **the title screen came
back** — the script ran and handed control back cleanly. Report (968 bytes):

```
open game:/                 -> ok (mount resolves; read returns nil)
open game:/system/init.lua  -> No such file
open save:/ns2jb.asb        -> ok  head="ASB\0\0…"
open sd:/                   -> No such file      (card out)
open /                      -> Invalid argument
open save:/../saveg.dat     -> No such file      (traversal normalised away)
os.execute('true') -> 0     io.popen -> 'popen' not supported
```

Conclusion: full Lua 5.1 with save write, no shell, no `sd:`, no traversal.

## Editor install (third-party save, no JKSV)

`Seedsow-Lua-Editor-Save.zip` v0.1.2 installed into the demo save with
`save-write-stage.cjs`: **275 files, 4,511,900 bytes, 9 replaces, 266 adds**, one
commit, read back and compared:

```
missing []   extra []   hash mismatches []   4,511,900 bytes
```

Then booted and loaded **slot 1**: the editor appeared, with
`Slot 4 sscode004.lua | 85 bytes | TEXT INSERT | Guard ON` and
`Ready. Choose slot 4-120; Save + publish makes it loadable after restart.
Airplane mode is fine.`

That is the released artifact running from a save we installed through our own
write path — no Switch 1, no JKSV, no Nintendo save transfer.

## Game dump (same held session)

OunceCake attached to the running session and mounted `base` + update `65536`
while the FS endpoint stayed live. Mirrored over FTP at ~7.5 MiB/s (74 MiB/s for
the small exefs):

| scope | files | size | manifest sha256 |
| --- | --- | --- | --- |
| whole tree | 95,987 | 20 GB | `76984046eb9721c8…` |
| `base/romfs` | 47,393 | 9.8 GB | `11a6487146b63786…` |
| `base/exefs` | 9 | 59.7 MiB | `67579bde2dfe52f7…` |
| `updates/65536/romfs` | 48,576 | 9.8 GB | `fa64d245cc0edccf…` |
| `updates/65536/exefs` | 9 | — | `41e479786dac1054…` |

## Untethered boot launcher in the demo save

Installed into `010042d022aea000` in one transaction, all four files verified
against a fresh backup before replacement and hashed back after the commit:

| file | bytes | sha256 (prefix) | role |
| --- | --- | --- | --- |
| `/ns2jb.asb` | 1946 | `f800caa253ec0c3a…` | stub: runs the slot-4 program, else `ns2jb.lua` |
| `/save9999.dat` | 27917 | `f19634f017d17b54…` | suspend launcher: `system/script.asb` #42 → `save:/ns2jb.asb` #1 |
| `/ns2jb.lua` | 1344 | `950fbade47f814af…` | body (fallback path) |
| `/sscode004.lua` | 1344 | `950fbade47f814af…` | body as editor slot 4 (`ssslot004.ref` names it) |

`commit -> 0x0`. The stub resolves its program through `ssslot004.ref`, so the
editor owns the loop: Choose slot 4, edit, Save + publish, restart.

## Console authoring limits and the editor's save path

The engine's text-entry dialog returns **at most 32 characters per entry**, and
the editor passes `textfieldsize='2048'` in vain. `Edit line` therefore replaces
a line with at most 32 characters and silently truncates longer ones, which is
why the payload is written with every line <= 32 characters.

The editor's own storage sequence was observed end to end: after one `Save file`
the save contained

```
ns2jb.lua      1142   (the saved edit)
ns2jb.lua.bak  1197   (previous version, kept for Restore .bak)
ns2jb.lua.new  1142   (staging copy, left behind)
```

so console-side saves do complete, and a bad save has a one-generation undo.

## SD card is not reachable from the game

With the microSD **inserted**, boot-time Lua reported:

```
sd no
sdw no
```

The game's VFS exposes `save:` and resolves `game:`, but not `sd:`. There is no
file channel to the card, so payload output cannot leave the save without an
exploit session (or the screen).

## Failure modes observed (worth knowing before you try)

| Symptom | Cause | What fixed it |
| --- | --- | --- |
| `0x7d402` on every space/type | title has no save data, or the app is holding it | launch the game once; close it fully |
| `2162-0002` host crash | promoted-root save operation, ~3 in 5 attempts | one save op per boot, restart after |
| `FS acquisition did not complete` (console response timeout at stage 2/4) | app not freshly opened, or SD card inserted (changes the FS save allocation) | console restart, SD card out, fresh SmileBASIC |
| `find-metadata failed: No candidate reproduced the external allocator link` | timing-sensitive allocator state | console restart and retry |
| `Directory exceeds the 64/256-entry probe limit` | tool-side list cap, not a console fault | raised to 2048 entries |

## What these results do not prove

- Writes were verified by reading the committed bytes back, not by observing the
  game accept them in every case. Where the game did consume them (editor slot 1,
  suspend boot) that is stated.
- File hashes from the dump are local integrity hashes; FTPS here has no per-file
  digest, only a `SIZE` comparison per file.
- The offline tests in `tests/` cover encoders and manifest logic. They are not
  evidence about console behaviour.
