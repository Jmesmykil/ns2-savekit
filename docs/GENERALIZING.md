# Generalising beyond Artemis

The core of this repository is not Artemis-specific. Everything under `tools/`
talks to **fsp-srv save data** through the exploit's promoted root:

- list installed titles, enumerate account uids
- open any title's save archive read-only or read-write
- pull it as a backup, add or replace files in one transaction, commit, verify
- delete a file

Artemis appears in two places only: `tools/artemis-save.py` (the BOW/ASB format)
and `payloads/` (Lua that the engine runs). Those are *adapters*, not the core.

## What generalises immediately

| Job | Tool | Notes |
| --- | --- | --- |
| Back up any title's save | `save-pull-root.cjs` | read-only, no commit |
| Restore / update / mod any title | `save-write-stage.cjs` | one open, one commit, per-file hash verify |
| Bulk install a save someone else built | `build-editor-manifest.py` + write-stage | what we used for the Lua editor |
| Remove a bad file | `save-delete-root.cjs` | single path |
| Find which account owns a save | `find-save-uid.cjs` | saves are per AccountUid |
| Survey what exists | `list-apps.cjs`, `save-list.cjs` | 9 titles, spaces and types |

That is a JKSV-shaped capability set, but driven live over RPC instead of from
homebrew on the console, and with hash verification on the way out.

## What has to stay guarded when you generalise

- **Allowlist, not a free hand.** `config/titles.json` extends the built-in
  write list; anything unlisted is refused before a handle is opened. Keep it to
  disposable or personally-owned titles.
- **Account saves only.** `space=User, type=Account`. System and proper-system
  save archives are a different permission domain and a different risk class;
  this toolkit does not target them, and should not.
- **Backup before write, always.** The replace path refuses to touch a file
  whose live bytes no longer match the backup you passed.
- **One transaction per boot.** The promoted-root save path crashes the host
  application roughly 3 times in 5 on our unit. Do one operation, restart after
  a crash.
- **A running game locks its save.** `0x7d402` on every space/type means "no save
  data", which also covers "the app is holding it". Close the game first.

## Repository shape if this grows

```
tools/        generic save access (this is the core)
config/       allowlist
adapters/     per-format code: artemis BOW/ASB, others as they appear
payloads/     per-engine code runners (Artemis Lua here)
docs/         results, limits, per-case notes
```

The Artemis work then becomes the first *case study*: a save-format adapter plus
an in-game code runner, rather than the whole project. The name
`artemis-untethered` describes that case study, not the toolkit; if the general
capability is the point, a neutral name (`ns2-savekit`, `savehold`, `Savour`) with
GitHub's rename-and-redirect is the cleaner home.
