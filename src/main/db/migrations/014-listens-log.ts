import type { Migration } from '../migrate'

/**
 * The listens log — **D17**.
 *
 * `play_history` (migration 009) is the transport's short-term memory: capped at
 * 500, skips included, read whole in one request. This is the other record. One
 * row per play that crossed the listened threshold, uncapped, append-only, and
 * every statistic Fermata reports is a query over it. `tracks.play_count` and
 * `tracks.last_played_at` become caches of this table rather than counters in
 * their own right — regenerable, which is the property that makes them safe to
 * be wrong.
 *
 * Schema only. The event that decides a play was a listen and writes the row is
 * W10-3/W10-4; nothing in this file has an opinion about the threshold.
 *
 * ## `SET NULL`, where 009 chose `CASCADE`
 *
 * This is the load-bearing line in the table. Migration 009's own note records
 * that a file *moved* between roots or folders reads as a delete plus an insert,
 * and it accepts losing a trail row to that, because a trail row is worth 500
 * rows of session history. Years of listening are not worth that price:
 * reorganising a folder would silently destroy the one thing in this database
 * that cannot be rebuilt from the files on disk, and the operator would find out
 * a year later, from a chart with a hole in it.
 *
 * So the reference is nullable and severs rather than cascades, and everything
 * the row needs in order to still mean something afterwards is *on* the row.
 *
 * ## The snapshot columns
 *
 * `title`, `artist_name`, `album_title`, `album_artist_name` and `duration_ms`
 * are copies, resolved through `track_overrides` at listen time, not joins
 * deferred to query time. Two reasons, and the second is the better one: they
 * have to survive the track's deletion, and they make the log *honest about the
 * past*. It reports the artist as it was tagged when you listened, not as you
 * have since corrected it. A join would quietly rewrite history every time the
 * operator fixed a tag.
 *
 * `title` is `NOT NULL` because a listen has to be attributable to something to
 * be worth a row; the rest are nullable because a library full of untagged files
 * still deserves a play count. Note that the outbox (012) makes the opposite
 * call on `artist_name` — it is `NOT NULL` there, because every scrobbling target
 * rejects a submission missing it. The two records diverge for untagged tracks by
 * this written rule rather than by a constraint failure at 2am.
 *
 * ## `listen_genres` copies rather than joins
 *
 * Same argument, plus a query-shape one. Genre stats have to outlive the track
 * like every other dimension on the row, and copying makes "top genres of 2026"
 * one indexed range-and-group rather than a scan that string-splits its way
 * through 365k rows. The columns match `track_genres` exactly because the writer
 * copies that table's rows verbatim — `genre_key` groups, `genre` displays, and
 * the same caveat applies here: `genre` is a property of the row, so anything
 * rendering a group has to pick a spelling rather than assume one.
 *
 * `WITHOUT ROWID` for the same reason 013 uses it: the primary key is the row
 * bar one column, so an implicit rowid would be a second copy of the key in a
 * second b-tree.
 *
 * ## The indexes, and the ones that are missing
 *
 * `idx_listens_started` is the range scan. Every dashboard question is "in this
 * window", and every "top N" is a grouping inside that window.
 *
 * `idx_listens_track` is the child side of the `SET NULL` reference. SQLite
 * indexes the parent of a reference and never the child, so without it every
 * track deletion during a scan is a full scan of what will become the largest
 * table in the database. `started_at` rides along because "this track's listens,
 * newest first" is the other question anyone asks of a `track_id`.
 *
 * `idx_listens_identity` is what makes a D11 import idempotent: `INSERT OR
 * IGNORE` on `(started_at, title, artist_name)`, so merging a bundle twice is
 * merging it once. SQLite does not collapse `NULL`s in a `UNIQUE` index, so an
 * untagged track's listens dedupe on nothing and re-import as duplicates. That
 * is accepted — untagged tracks are exactly where duplicate statistics matter
 * least, and the alternative is a sentinel string that then leaks into every
 * `GROUP BY` in the app. It also means the *writer* has to tolerate the
 * constraint; a real same-millisecond collision needs two transports committing
 * at once, which Fermata does not have, but "cannot happen" and "throws if it
 * does" are different promises.
 *
 * **No indexes on `artist_name`, `album_title` or `title`.** Deliberately
 * absent, not overlooked. The dashboard's shape is range first, group second;
 * `idx_listens_started` serves the range, and sorting one window's worth of rows
 * is cheap. They are the first thing to add when a query is *measured* slow.
 * Adding three indexes to the fastest-growing table in the database on a guess
 * is the wrong trade in both directions — write cost now, for a read that may
 * never be the slow one.
 *
 * No backfill. There is no earlier record of what was listened to; `play_history`
 * holds at most 500 rows, includes skips, and has no `ms_listened` to give, so
 * seeding from it would manufacture statistics rather than recover them.
 */
export const listensLog: Migration = {
  version: 14,
  name: 'listens-log',
  // The first migration to set it, and a no-op here by construction: the table
  // is created empty, so the rebuild it triggers finds nothing to change. Set
  // anyway, because the flag is a statement about what the migration touched
  // rather than about what the rebuild will find, and a convention that only
  // starts being followed once it matters is one that will not be.
  touchesListens: true,
  sql: `
CREATE TABLE listens (
  id                INTEGER PRIMARY KEY,
  -- SET NULL, not CASCADE: a moved folder must not erase history.
  track_id          INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  started_at        INTEGER NOT NULL,  -- UTC ms; the transport-commit moment
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
  genre_key TEXT    NOT NULL,   -- casefolded, trimmed: the grouping identity
  genre     TEXT    NOT NULL,   -- display spelling as it was at listen time
  PRIMARY KEY (listen_id, genre_key)
) WITHOUT ROWID;

CREATE INDEX idx_listen_genres_key ON listen_genres(genre_key, listen_id);
`
}
