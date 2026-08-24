---
taskId: 01M0TDNVBPBXZCA5WH3G70JSSM
title: Migration 016 + scanner indexed_at
status: in-review
priority: high
labels:
  - main
  - db
  - library
  - D24
  - D25
workstream: W13
workstreamId: W13-2
dependsOn:
  - 01M0TDNEXM17131MG55E72K2EK
order: 1
created: '2026-08-24T17:39:18.005Z'
updated: '2026-08-24T18:19:09.778Z'
---
Spec: wiki `fermata-quick-access` → Data contract (Schema), D24, D25.

Migration **016** plus the scanner change that keeps `indexed_at` honest. Retires W12 recorded-debt #1.

**Tables** (mirror `track_favorites` exactly):
- `playlist_favorites(playlist_id INTEGER PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE, favorited_at INTEGER NOT NULL)` + `idx_playlist_favorites_at`.
- `artist_favorites(artist_id INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE, favorited_at INTEGER NOT NULL)` + `idx_artist_favorites_at`.

**Arrival clock.** `ALTER TABLE tracks ADD COLUMN indexed_at INTEGER`, backfill every row from `roots.added_at` falling back to a single migration `nowMs`, then `idx_tracks_indexed_at`. SQLite cannot `ADD` a NOT NULL column without a constant default — backfill, then enforce in the insert path rather than rewriting the table. Match the migration house style (002/004/015) for how nullability is finally expressed.

**Scanner.** Set `indexed_at = nowMs` on first `INSERT` of a `(root_id, rel_path)`, and **omit it from the upsert's `UPDATE` set** — a rescan is not an arrival. `mtime` stays the rescan key and is never read as arrival.

**Tests** (`tests/main/`): first insert stamps `indexed_at`; a rescan-upsert of the same `(root_id, rel_path)` leaves it unchanged (and updates `mtime`); backfill resolves `roots.added_at` then the `nowMs` fallback; favoriting a playlist/artist then deleting it cascades the favorite row.

**Done when:** the migration applies clean on an existing library, `indexed_at` is stamped once and never on rescan, and both favorite tables cascade on delete.
