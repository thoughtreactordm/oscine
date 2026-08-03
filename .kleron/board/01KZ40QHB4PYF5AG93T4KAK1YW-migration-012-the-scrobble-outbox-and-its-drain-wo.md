---
taskId: 01KZ40QHB4PYF5AG93T4KAK1YW
title: Migration 012 — the scrobble outbox and its drain worker
status: todo
priority: high
labels:
  - schema
  - main
  - D19
workstream: W11
workstreamId: W11-2
dependsOn:
  - 01KZ40Q2G2QD6XPPMWFKBZKTZ9
order: 58
created: '2026-08-03T14:34:02.468Z'
updated: '2026-08-03T17:20:58.830Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Data model → Migration 015, and → Scrobbling → "The outbox".

**The surface most likely to grow bugs in this stream.** It gets its own card and its own tests, and it is built against W11-1's stub target before any real network code exists.

```sql
CREATE TABLE scrobble_queue (
  id                INTEGER PRIMARY KEY,
  target            TEXT    NOT NULL,  -- 'lastfm' | 'listenbrainz'
  kind              TEXT    NOT NULL,  -- 'scrobble' | 'love' | 'unlove'
  listen_id         INTEGER,           -- provenance only, no FK
  track_id          INTEGER,           -- provenance only, no FK
  artist_name       TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  album_title       TEXT,
  album_artist_name TEXT,
  duration_s        INTEGER,
  timestamp         INTEGER NOT NULL,  -- UTC seconds — Last.fm's field, not ms
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);

CREATE INDEX idx_scrobble_queue_ready ON scrobble_queue(target, next_attempt_at);
```

**No foreign keys, deliberately.** The queue must still be able to send after the track is gone from the library — which is exactly the case where the network came back after a rescan. Everything transmitted is snapshotted onto the row.

**Persist first, submit second — always, even when online.** A scrobble that exists only in flight is one lost to a closed laptop lid, and a music player is mostly used on laptops.

**The drain worker** wakes on enqueue, on network return, on app start, and on a timer. Per target: take up to `capabilities.batchSize` ready rows ordered by `timestamp` ascending (so a long offline stretch replays in the order it happened), submit, **delete what was accepted**, and apply exponential backoff with jitter to `next_attempt_at` for what was not. Rows are deleted on success, so the table's steady state is empty and its depth is a direct readout of how long the network has been away — which is what W11-7 displays.

**Three failure classes, three behaviours.** Retryable (rate limit, 5xx, offline) → backoff. Terminal-for-the-account (invalid session) → stop draining, mark the account disconnected, do not burn attempts. Terminal-for-the-row (a payload the server will never accept) → drop it with `last_error` recorded, because retrying it forever is an outbox that never drains.

**Tests** (`tests/main/`), against a stubbed target: partial-accept batches leave exactly the rejected rows; backoff progresses and is bounded; a terminal-account failure halts the drain without incrementing every row's `attempts`; ordering after a simulated week offline; two targets drain independently; a drain interrupted by `NET_SCOPES` cancellation loses nothing.
