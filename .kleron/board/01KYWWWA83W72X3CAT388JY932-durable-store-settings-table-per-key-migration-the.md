---
taskId: 01KYWWWA83W72X3CAT388JY932
title: 'Durable store — settings table, per-key migration, the settings.* IPC surface'
status: in-review
priority: high
labels: []
workstream: W8
workstreamId: W8-2
dependsOn:
  - 01KYWWVQQB80JQ6KK80HX96KYN
order: 1
created: '2026-07-31T20:12:03.713Z'
updated: '2026-08-01T03:23:24.315Z'
---
The main-process half of the split: durable settings in SQLite, read by main before the window opens, exposed to the renderer over a typed channel.

## Schema

A new migration alongside `001-schema-v1.ts` and `003-replaygain-jobs.ts`:

```
CREATE TABLE settings (
  key         TEXT NOT NULL,
  scope_kind  TEXT NOT NULL,   -- 'global' | 'playlist' | 'root' | ...
  scope_id    INTEGER,         -- NULL for global
  value       TEXT NOT NULL,   -- JSON
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (key, scope_kind, scope_id)
)
```

`scope_kind`/`scope_id` are laid in now even though W8-5 is what uses them — retrofitting a primary key later is worse than carrying two unused columns.

## Read path

On read, compare the stored `version` against the descriptor's. If it is behind, run the descriptor's `upgrade` chain and write the result back. If the key has no descriptor, return it untouched and do not migrate it — this is the unknown-key preservation rule from W8-1, and it is what makes branch-switching non-destructive.

A value that fails `validate` resolves to the descriptor default and emits a `library.notice`-style notice. It does not throw and it does not overwrite the stored value, so an operator can downgrade and recover it.

## IPC

New channels in `src/shared/ipc.ts` following the existing `{ request, response }` declaration pattern:

- `settings.getAll` — every durable key resolved, for renderer hydration
- `settings.set` — one key (with optional scope), validated main-side; the renderer is not trusted to have validated
- `settings.reset` — one key, one category, or all
- `settings.changed` — a broadcast event, main to renderer, carrying the changed keys

Main-side consumers read through a `settingsService` accessor, never by querying the table directly.

## Done when

- Migration applies cleanly on a fresh database and on an existing one.
- `tests/main/settings/` covers: round-trip, version upgrade on read with write-back, unknown-key passthrough, invalid value falls back without mutating storage, and scope-keyed rows not colliding with global.
- Main can resolve a durable setting before `BrowserWindow` is constructed — proven by a test, since this is the property that justifies the whole main-side store.
- The renderer is not wired up yet. That is W8-4.
