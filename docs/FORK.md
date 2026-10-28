# Fork scope and guards

This fork retains dougchansan's MIT ns2-savekit history and ports the recorded
baseline → editor assets → native slot 3 save → corrective write route. General
save tools, save-format code and engine patches remain upstream work. The
separately fetched Seedsow Lua Editor is DialingSpoon527's 0BSD project.

`build-slot3-assets.py` pins eight source files, changes only the slot-3 repair
loop and regenerates its bootstrap. Eight generated outputs matched the recorded
stage byte for byte. No game save or image asset is redistributed in this fork.

`prepare-editor-slot.py` validates complete flat hashed backups, a nonzero raw
account UID and Demo title `010042D022AEA000`. Its shared phase plan produces
baseline four files, prerequisite eight adds plus one replacement, or corrective
two replacements. The native slot is structurally parsed; actual menu registration
still requires observation in the game. An optional save ID is descriptive only.

`record-save-backup.py` runs the historical pinned pull once, checks successful
User/Account mount and full UID, reconciles logged sizes/counts with the host
files, and reads those files twice. It binds the generated inventory to the run,
session and one-use transaction. `hostIndependentReadbackVerified` describes host
re-read; `deviceProvenanceAuthenticated` stays false. Neither a supplied ID nor a
host inventory independently authenticates device provenance.

`write-prepared-stage.py` derives identity and paths, validates pinned writer,
backup receipt, live run/session, stage/backup hashes, exact file targets and the
shared phase plan. It reserves the write once and requires one successful commit
and complete readback. The pinned writer compares full hashes internally, while
its log prints success tags and 16-character hash prefixes. The wrapper requires
those tags, prefixes, sizes and the exact expected file set; it does not claim
the log contains full hashes. Exit zero or committed bytes alone is insufficient.

Files must be regular, flat, non-symlink paths without traversal or case aliases.
Limits are 1,024 entries, 8 MiB per file and 32 MiB total, including the projected
save. Output directories are never reused. Failure logs and consumed reservations
remain for review. [Host route](ESTABLISHED-ROUTE.md) defines the owned release.

The historical final write had 45 files and preserved 43 after two replacements;
new receipts compute their own counts. Editor launch and one normal-restart
launch were observed historically. The portable host and wrappers have offline
coverage only, with no new console acceptance. Preserve backups and private
identities, generated packages, captures and receipts outside the repository.
