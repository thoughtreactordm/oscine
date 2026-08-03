---
taskId: 01KZ40JCB1BTE51EE841D51FJ1
title: The listen commit — one transaction at departure
status: todo
priority: high
labels:
  - ipc
  - main
  - playback
  - D17
workstream: W10
workstreamId: W10-4
dependsOn:
  - 01KZ40HJ61C5Q90SE0KAGWPW91
  - 01KZ40HZE65905A4K5JDY3MSY7
order: 46
created: '2026-08-03T14:31:13.505Z'
updated: '2026-08-03T14:31:13.505Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → The listen event.

Wires W10-3's accumulator to W10-2's table. New IPC surface starting in `src/shared/ipc.ts`, per the convention.

**The commit moment is departure, not threshold-crossing** — track end, skip, stop, or the transport moving on. One write carrying the final `ms_listened`, rather than a write at threshold plus an update at the end. If the threshold was never crossed, nothing is written.

**One transaction in main**, doing all of:
- insert the `listens` row, with title/artist/album/album-artist/duration snapshotted **override-resolved** (D7 — `track_overrides` wins, because that is what the operator believes they listened to)
- copy the track's `track_genres` rows into `listen_genres`
- increment `tracks.play_count` and set `tracks.last_played_at` (see W10-5 for why this is a cache, not a counter)
- enqueue the scrobble row, once W11-5 lands — leave the seam, not the code

**`before-quit` flushes** an in-flight listen that has already crossed threshold. A hard kill loses it; that is the accepted cost of the one-write design, and it is recorded as a debt. Do not add a heartbeat that writes to SQLite every few seconds for the life of the app to protect a single row.

**Do not touch `play_history`.** It keeps being written at transport-commit, unconditionally, skips included. The two records answering different questions is the design, not an oversight — read `src/shared/history.ts` before changing anything there.

**Tests** (`tests/main/`): end / skip / stop / quit-while-playing each produce the right number of rows with the right `ms_listened`; a skipped track appears in `play_history` and **not** in `listens`; repeat-one produces one of each per pass with distinct `started_at`; a track with `track_overrides` snapshots the override, not the tag; a track with no genre produces no `listen_genres` rows and still commits.

**Done when:** playing a real track past threshold in the running app leaves exactly one `listens` row with a plausible `ms_listened`, and skipping one leaves none.
