---
taskId: 01M4J4APM8SYSPCNT322MSG81G
title: 'Scratch composer — read-only library attach, host + imported listens'
status: backlog
priority: medium
labels:
  - D34
  - D34.3
  - main
  - spike-first
workstream: W22
workstreamId: W22-2
order: 28
created: '2026-10-10T05:24:47.367Z'
updated: '2026-10-10T05:24:47.367Z'
---
Spec: wiki `oscine-field-notes` → D34, D34.3.

**Spike first, then build.** Before anything else, verify and record on the card:
1. A second better-sqlite3 connection with `main = :memory:` can `ATTACH` the live `library.db` with `mode=ro` while the app's own connection holds it in WAL mode, and reads see committed data.
2. With `listens`/`listen_genres` created in `main`, unqualified `tracks`/`track_overrides` resolve to `lib`, and `new StatsStore(scratch)` (`src/main/stats/store.ts`) runs its existing queries unchanged.

If either fails, stop and bring it back to the design page rather than working around it.

**Build** (`src/main/recap/`):
- Open the scratch connection; create `listens` (same columns + `device_id`) and `listen_genres` with the identity index `UNIQUE(started_at, title, artist_name)`.
- Copy the host's listens in first (tagged with the host install ID), then each validated import (W22-1's validator) with `INSERT OR IGNORE`. **Host wins a collision.**
- Link imported rows to local tracks by `(title, artist_name, album_title)` against `lib.tracks`, writing `track_id` in the scratch copy only.
- Expose a composer that yields the scratch `Database` plus a sources manifest (per device: label, row count, range, rows dropped as duplicates), and closes it.

**Tests:**
- Writes to the library are impossible: any write through the scratch connection to `lib.*` fails, and `library.db`'s `listens` is byte-for-byte unchanged after a full compose.
- Importing the same file twice, two overlapping exports, and the host's own export all leave the row count unchanged.
- An imported listen of a track the host owns gets linked; one it does not stays `track_id NULL` and still counts.

**Done when:** the spike result is recorded and the composer passes the tests above.
