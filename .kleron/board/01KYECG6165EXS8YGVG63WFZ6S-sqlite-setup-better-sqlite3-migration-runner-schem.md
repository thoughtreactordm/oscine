---
taskId: 01KYECG6165EXS8YGVG63WFZ6S
title: 'SQLite setup: better-sqlite3, migration runner, schema v1'
status: in-review
priority: high
labels:
  - M1
workstream: W2
workstreamId: W2-1
dependsOn:
  - 01KYECF654VD7979YA2APD24PW
effort: high
order: 0
created: '2026-07-26T04:56:26.918Z'
updated: '2026-07-29T03:50:29.302Z'
---
The persistence layer, per design section 4. Schema v1 lands whole even though M1 only exercises part of it — the unused columns cost nothing and a migration to add them later costs a card.

## Scope

- `better-sqlite3` in the main process, database file under Electron's `userData`. Confirm the native module rebuilds correctly for the Electron ABI on both Windows and Linux — this is the single most common electron-vite packaging failure and finding it now beats finding it at M6.
- A forward-only migration runner keyed on `user_version`. Migrations are numbered files, applied in a transaction, with the version bumped in the same transaction.
- Schema v1 exactly as specified in design section 4: `roots`, `artists`, `albums`, `tracks`, `track_overrides`, `playlists`, `playlist_entries`, `tracks_fts`.
- Enable `PRAGMA foreign_keys = ON` explicitly. It is off by default per-connection and every `ON DELETE CASCADE` in the schema silently does nothing without it.
- WAL mode for concurrent read during background scans.
- Path helpers: `toRelPath(rootPath, absPath)` producing POSIX-normalised output, and `toAbsPath(rootPath, relPath)` rejoining per-platform.

## Acceptance

- Fresh launch creates the database and applies all migrations; second launch is a no-op.
- Unit tests for the path helpers **round-trip across both separator conventions** — a Windows-produced `rel_path` must resolve correctly given a Linux root, and vice versa. This is the mechanism D11's export bundle depends on; if it is wrong, the failure appears months later on the other machine.
- A test asserting cascade delete actually cascades, which also proves the pragma is on.

---

# Outcome — done on Windows; the Linux half is now scriptable rather than assumed

Commits `2dcc91e`, `6cfdb42`, `b6b31aa`. 45 unit tests, typecheck and build all green.

## Acceptance results

| Criterion | Result |
|---|---|
| Fresh launch creates the database and applies all migrations | Pass — `migrated v0 to v1 (schema-v1)` |
| Second launch is a no-op | Pass — `schema v1, up to date` |
| Path helpers round-trip across both separator conventions | Pass — both directions, plus a return trip |
| Cascade delete actually cascades | Pass — three cascade paths, with a negative control |

Verified by launching the real app twice from a deleted `userData` database and capturing main-process stdout, then inspecting the resulting file directly: `user_version = 1`, `journal_mode = wal`, `integrity_check = ok`, all eight tables present.

## The native module does not need rebuilding — the card's premise has changed

better-sqlite3 13 ships **Node-API prebuilds**, one per platform rather than one
per ABI. Node-API is ABI-stable across runtimes, so the same binary loads under
system Node (ABI 137) and Electron 43 (ABI 148) unchanged. There is no rebuild
step, and `@electron/rebuild` was installed and then removed as dead weight.

Two consequences worth carrying forward:

- **Unit tests run under plain Node.** No `ELECTRON_RUN_AS_NODE` harness, no
  Electron test runner, no `cross-env`. Vitest stays ordinary.
- **The packaging risk is smaller than the card assumed**, but not zero: the
  prebuilds still have to survive asar packing. `asarUnpack: '**/*.node'` was
  already in `electron-builder.yml` from W1-2 and covers `prebuilds/*.node`.

## The Linux gap, carried forward from W1-2

Still true: **nothing in M1 has been executed on Linux.** Rather than restate that
as a note, this card adds `npm run verify:native`, which re-executes itself under
Electron and asserts the binding loads, WAL engages, the foreign-key pragma
takes, and FTS5 with `unicode61 remove_diacritics 2` is compiled in. It passes on
Windows.

**W6-1 should run it on `ubuntu-latest`.** That is the cheapest way to close the
half of this card's first bullet that a Windows machine cannot answer, and it
fails loudly rather than silently if a Linux prebuild is missing.

## Corrections and decisions worth knowing about

- **The card's foreign-key premise is right about SQLite and wrong about the
  driver.** `PRAGMA foreign_keys` is indeed off by default in SQLite, but
  better-sqlite3 turns it **on** by default. Measured, not assumed — a fresh
  connection that never set the pragma reported `1`. The explicit pragma stays, so
  behaviour does not depend on a driver default, but the comment saying "off by
  default" would have misled the next reader and was corrected. It also means the
  "pragma is on" assertion is weak on its own, so a **negative control** was added:
  a test showing the cascade genuinely stops happening when the pragma is turned
  off, which is what gives the cascade tests teeth.
- **`toAbsPath` is a security boundary, not just a formatter.** W2-2 wires it into
  `resolveTrackPath`, which feeds the `fermata://` handler. Containment is
  re-checked *after* joining rather than trusted from segment filtering, so
  traversal that only escapes post-normalisation is caught.
- **It splits on `/` only, never on `\`.** Backslash is a legal character in a
  Linux filename; treating it as a separator would silently resolve `AC\DC.mp3` to
  the wrong file. Windows-side backslash traversal is still caught, by the
  containment check rather than by the split. Both cases are tested.
- **Migrations are TypeScript modules, not `.sql` files.** electron-vite bundles
  main into a single file, so a sibling `.sql` would not be copied into `out/` and
  would fail only in the packaged build — the worst place to find it. The registry
  is an explicit array and `migrate` rejects it if versions are not contiguous, so
  a file written but never registered fails at startup instead of silently
  skipping a step.
- **Refuses a database newer than the code** (`SchemaTooNewError`). Forward-only
  means a rollback to an older build must not write rows the newer build cannot
  read.
- **Five indexes beyond design section 4.** Section 4 specifies tables; SQLite
  indexes the parent side of a foreign key but never the child side, so every
  cascade and every "entries for this playlist" lookup would otherwise be a full
  scan. Worth folding back into the design doc at `/doc-refine`.
- **`synchronous = NORMAL` and `busy_timeout = 5000`.** The first is safe
  specifically because of WAL — a crash can cost recent commits but cannot corrupt —
  and a library rebuilt by rescanning a folder trades that for scan throughput
  happily. The second stops a scan's write transaction throwing `SQLITE_BUSY` at a
  UI read.
- **`db.close()` on `will-quit`, not `window-all-closed`.** It fires on every exit
  path, and the clean close is what checkpoints `-wal` back into the database.

## Not done here, deliberately

`PendingLibraryService` is untouched — W2-2 replaces it. This card establishes only
that the database exists, is migrated and is correctly configured.

A note for whoever writes migration 2: `PRAGMA foreign_keys` is a no-op inside a
transaction, so a migration needing SQLite's 12-step table rebuild cannot turn it
off from inside `migrate`. It has to be toggled around the call.
