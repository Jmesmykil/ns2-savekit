# Engine patches these tools expect

The tools talk to a run folder produced by ns2jb. A few of them call engine
functions that are **not** in upstream ns2jb: they come from the local patch set
used while developing this toolkit. Upstream-only checkouts work for some
actions and fail for others, so the set is listed here.

| Engine module | Patch | What breaks without it |
| --- | --- | --- |
| `switch2/app/mounted-save.cjs` | `inspectMountedFilesystem()` export | `find-save-uid.cjs` cannot scan for the uid; `kit.cjs` falls back to asking for it |
| `shared/ipc.cjs` | CMIF pointer/static descriptors | `save-write-stage.cjs` and friends cannot create files (`CreateFile` returns `0x2ee002`) |
| `switch2/memory/probe-reserved-gap.cjs` | extra pin retries / window sizing | acquisition is less reliable on our unit; not required |
| `switch2/retained/find-metadata.cjs` | 24 move attempts | acquisition is less reliable; not required |

## Symptoms

- `mounted.inspectMountedFilesystem is not a function` — the uid scan helper is
  missing. Pass the 32-hex account uid to `save-pull-root.cjs` and
  `save-write-stage.cjs` yourself; everything else still works.
- `OpenFile for write failed: 0x2ee002` or `CreateFile failed: 0x2ee002` — the
  pointer-descriptor patch is missing, so new files cannot be created. Adding a
  file to a save needs it; reading a save does not.

## Getting a patched checkout

The patches live in the `ns2jb-rpc` fork used to develop this toolkit. Upstream
is [gitlab.com/kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb); this repository
does not vendor or redistribute the exploit. If you only want read access, plain
upstream is enough: `save-pull-root.cjs` with an explicit uid works, and
`kit.cjs` will prompt for the uid.
