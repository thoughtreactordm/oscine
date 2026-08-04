---
taskId: 01KZ40HJ61C5Q90SE0KAGWPW91
title: Migration 014 — the listens log
status: done
priority: high
labels:
  - schema
  - D17
workstream: W10
workstreamId: W10-2
dependsOn:
  - 01KZ40H1BK77657BBTKKKAQD9B
order: 18
created: '2026-08-03T14:30:46.721Z'
updated: '2026-08-04T15:06:59.084Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → D17 and → Data model → Migration 014.

**Renumbered from 013.** W11-2's scrobble outbox took 012 because it depends on none of W10's tables and `migrate` refuses a registry with a hole in it. Nothing was released, so the numbers were free to move.

The durable record every statistic is computed from. Schema only — the event that writes it is W10-3/W10-4.

```sql
CREATE TABLE listens (
  id                INTEGER PRIMARY KEY,
  -- SET NULL, not CASCADE. See below; this is the load-bearing line.
  track_id          INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  started_at        INTEGER NOT NULL,  -- UTC ms, the transport-commit moment
  ms_listened       INTEGER NOT NULL,  -- accumulated audible ms
  duration_ms       INTEGER,           -- snapshot of the track's duration then
  title             TEXT    NOT NULL,  -- snapshots, override-resolved at listen time
  artist_name       TEXT,
  album_title       TEXT,
  album_artist_name TEXT
);

CREATE INDEX idx_listens_started ON listens(started_at);
CREATE INDEX idx_listens_track ON listens(track_id, started_at);
CREATE UNIQUE INDEX idx_listens_identity ON listens(started_at, title, artist_name);

CREATE TABLE listen_genres (
  listen_id INTEGER NOT NULL REFERENCES listens(id) ON DELETE CASCADE,
  genre_key TEXT    NOT NULL,
  genre     TEXT    NOT NULL,
  PRIMARY KEY (listen_id, genre_key)
) WITHOUT ROWID;

CREATE INDEX idx_listen_genres_key ON listen_genres(genre_key, listen_id);
```

**Why `SET NULL` and snapshots, when migration 009 chose `CASCADE`.** 009's own comment records that a file moved between roots or folders reads as a delete plus an insert. The trail can afford that — it is 500 rows of session memory. Years of listening cannot: reorganising a folder would silently destroy the one thing in the database that cannot be rebuilt, and the operator would discover it a year later. The snapshot is also what makes the log honest about the past — it reports the artist as it was tagged when you listened, not as you have since corrected it.

**Why `listen_genres` copies rather than joins.** Genre stats have to survive the track's deletion like everything else on the row, and it makes "top genres of 2026" one indexed query instead of a range scan that string-splits 365k rows.

**Why the identity index.** It makes D11 import `INSERT OR IGNORE`, so merging twice is merging once (W10-13). Note SQLite does not collapse `NULL`s in a `UNIQUE` index, so an untagged track's listens dedupe on nothing — accepted, because untagged tracks are where duplicate stats matter least and a sentinel string would leak into every group-by.

**No rollup indexes on `artist_name`, `album_title` or `title`.** Deliberately absent, not overlooked: the dashboard's shape is range-first then group, `idx_listens_started` serves the range, and sorting one range's worth of rows is cheap. Add them when a query is *measured* slow — three indexes on the fastest-growing table in the database, added on a guess, is the wrong trade.

**Done when:** the migration applies forward on a real database, `PRAGMA foreign_key_check` is clean, and a test proves deleting a track leaves its listens with `track_id IS NULL` and every snapshot column intact.
