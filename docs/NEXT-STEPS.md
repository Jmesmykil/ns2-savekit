# Next steps: untethered

"We are untethered" means: the game runs our code at boot, and we can change that
code, without SmileBASIC, an RPC session, or a PC in the loop. We are already
half-way there, and the remaining half is smaller than it looks.

## What already survives without the exploit

`save9999.dat` + `save:/ns2jb.asb` are ordinary files in the save. The engine
looks for the suspend slot at every boot (`save_prefix="save"`,
`save_suspend=9999`) and resumes it, so **every launch of the game runs our Lua
with no exploit present**. Verified: after a boot that ran the payload, the
launcher file was still there and still pointed at `save:/ns2jb.asb` — the
engine's delete-after-load step only runs on its own `suspend_load` path, which a
retargeted caret bypasses.

So the console no longer needs SmileBASIC to *execute* anything. What still needs
it is everything that moves bytes across the boundary:

| Still tethered | Because |
| --- | --- |
| editing the payload | `ns2jb.asb` is written from the Mac by `save-write-stage.cjs` |
| reading the payload's output | `ns2jb-report.txt` is pulled over fsp-srv |
| re-arming after a game update | the launcher blob is generated on the Mac |

Each of those has a console-only replacement.

## 1. Split the launcher into a stub and an editable body

Today `ns2jb.asb` embeds the whole payload, so changing behaviour means rewriting
the ASB from the Mac. Make it a stub that reads a Lua file and runs it:

```lua
function ns2jb_boot(engine)
  local base = engine:var("s.savepath")
  local file = io.open(base .. "/ns2jb.lua", "rb")
  if not file then return end
  local source = file:read("*a")
  file:close()
  local chunk = loadstring(source, "@" .. base .. "/ns2jb.lua")
  if chunk then pcall(chunk, engine) end
end
```

`ns2jb.lua` is not on the editor's protected list (`ssedit*`, `ssseed*`,
`ssboot*`, `ssethumb`, `sed01–03.`, `ssNNN.asb`), so the editor can write it with
**Save file** or **Save + publish**. That closes the authoring loop: edit on the
console, restart the game, code runs. The stub itself then never needs to change.

## 2. Output on screen instead of in a file

The reason our dialog never appeared during the first launch was that the
suspend-resume path restores a script position, not a drawn scene — nothing had
built the UI. That is no longer true once the editor or the title screen is up.
Have the payload end with a dialog (and keep the `jump system/first.iet
label="title"` fallback), so results are read on the TV instead of pulled.

If a file is still wanted, write it as Lua comments into a slot the editor can
open (`sscodeNNN.lua`) — the editor displays it with no PC involved.

## 3. Re-arm from the console

Re-arming is a byte copy, not a parse: keep a prebuilt retargeted blob in the
save (say `ns2jb-seed.bin`) and have the payload copy it to `save9999.dat`:

```lua
local src = io.open(base .. "/ns2jb-seed.bin", "rb"); local data = src:read("*a"); src:close()
local dst = io.open(base .. "/save9999.dat", "wb"); dst:write(data); dst:flush(); dst:close()
```

`io.open(..., "wb")` on `save:` is confirmed working from inside the game, so a
game update that removes the suspend file no longer costs an exploit session.

## 4. Keep both launchers

The editor's slot mechanism (`save0001.dat` → `save:/sed01.asb`) and our suspend
slot are independent. Keep them both: if a title update changes one, the other
still lands. The editor also gives a third thing we did not have — a way to run a
program **on demand** rather than only at boot.

## 5. Then the native work, still PC-free

With a self-updating boot payload, native-code experiments stop costing exploit
cycles. The v3 payload already sketches the loop: mutate a pluto blob, call
`unpersist`, flush a line per case, and guard against boot loops with a marker
file that disables the risky block after a crash. Once an input kills the
process, the same mechanism persists it for the next boot.

The remaining thing that genuinely wants the exploit is bulk exfiltration —
pulling multi-megabyte dumps off the console. OunceCake over FTP does that well
while a session is held, and it is not needed for anything else.

## Order I would do it in

1. Stub + `ns2jb.lua` loader (one exploit session to install, then never again).
2. Dialog output over a live UI (no session).
3. Seed blob + re-arm (no session).
4. Re-run the pluto fuzz from the boot payload and read the result on screen.
5. Only then spend console time on the malformed-BOWS/pluto native targets.
