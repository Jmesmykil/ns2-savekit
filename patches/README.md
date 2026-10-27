# Engine patches for full functionality

These two patches add the engine support this toolkit's write path needs. They
were written against the `kurumuz.fixrpc` merge of
[ns2jb](https://gitlab.com/kurumuz/ns2jb) (`eb2bdec`). They contain no exploit
logic of their own: one adds a HIPC descriptor form, the other exports a helper
that already existed.

| patch | adds | without it |
| --- | --- | --- |
| `0001-shared-ipc-pointer-descriptors.diff` | CMIF/HIPC static "pointer" descriptors in `engine/shared/ipc.cjs`, so a path buffer can be passed by address | creating a file in a save fails with `0x2ee002` |
| `0002-mounted-save-inspect-export.diff` | exports `inspectMountedFilesystem` from `engine/switch2/app/mounted-save.cjs` | `find-save-uid.cjs` cannot scan for the account uid |

## Apply

```sh
git clone https://gitlab.com/kurumuz/ns2jb ns2jb
cd ns2jb
git apply -3 /path/to/ns2-savekit/patches/0001-shared-ipc-pointer-descriptors.diff
git apply -3 /path/to/ns2-savekit/patches/0002-mounted-save-inspect-export.diff
node --check engine/shared/ipc.cjs && node --check engine/switch2/app/mounted-save.cjs
```

Or run `sh patches/apply.sh /path/to/ns2jb`.

`-3` asks git to merge the hunks; if upstream has moved far enough that a hunk
does not apply, resolve it by hand - the changes are small and self-contained.
Nothing else in the toolkit depends on patched engine code: `save-pull-root.cjs`,
`list-apps.cjs`, `save-delete-root.cjs` and the encoders work on an unpatched
checkout, but adding files to a save needs patch 1.

## Verified

Both patches applied cleanly to a fresh clone of upstream (`81d5bb1`) with
`git apply -3`, and the two patched files are then **byte-identical** to the ones
this toolkit was developed and tested against. So the hardware evidence in
`docs/RESULTS.md` - four committed writes, all read back and hashed, plus the
275-file editor install - applies to a patched upstream checkout exactly.
