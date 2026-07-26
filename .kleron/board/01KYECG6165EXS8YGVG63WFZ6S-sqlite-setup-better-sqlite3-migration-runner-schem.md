---
taskId: 01KYECG6165EXS8YGVG63WFZ6S
title: 'SQLite setup: better-sqlite3, migration runner, schema v1'
status: todo
priority: high
labels:
  - M1
workstream: W2
workstreamId: W2-1
dependsOn:
  - 01KYECF654VD7979YA2APD24PW
effort: high
order: 4
created: '2026-07-26T04:56:26.918Z'
updated: '2026-07-26T04:56:26.918Z'
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
