import type { Migration } from '../migrate'

/**
 * The scrobble outbox — **D19**.
 *
 * Every listen destined for a scrobbling service is written here *before* it is
 * submitted, and deleted once a target has accepted it. Persist first, submit
 * second, always, even when the network is up: a scrobble that exists only in
 * flight is one lost to a closed laptop lid, and a music player is mostly used
 * on laptops.
 *
 * ## Numbering
 *
 * The design document calls this migration 015, behind W10's 012–014. It landed
 * first because it needs none of them — see "No foreign keys" below — and
 * `migrate` refuses a registry with a hole in it, so waiting would have meant
 * building the outbox against a schema that could not be applied. Nothing is
 * released, so the numbers were still free to move; W10's cards were renumbered
 * to 013/014/015 rather than this table being given a version it could not have.
 *
 * ## No foreign keys, deliberately
 *
 * `listen_id` and `track_id` are provenance and nothing else. The queue must
 * still be able to send after the track has left the library, which is exactly
 * the case where the rescan that removed it and the network coming back are the
 * same afternoon. So everything that goes on the wire is snapshotted onto the
 * row — artist, title, album, album artist, duration — and the queue can drain
 * against a library that no longer contains the track it is talking about.
 *
 * That independence is also why this table can sit at 012 with `listens` at
 * 014: there is no reference to resolve, in either direction.
 *
 * ## Rows are deleted on success
 *
 * The steady state of this table is empty, which is what makes its depth a
 * direct readout of how long the network has been away — the number W11-7
 * displays. A design that marked rows sent instead would grow forever and turn
 * "3 scrobbles waiting" into a query with a predicate in it.
 *
 * ## `artist_name` and `title` are `NOT NULL`
 *
 * Because every target rejects a scrobble missing either, so a row without them
 * is a row that can never drain. A track with no artist tag is therefore never
 * enqueued — it still gets its `listens` row, because Oscine's own statistics
 * have no such requirement, and where the two records legitimately diverge it
 * should be by a written rule rather than by a constraint failure at 2am.
 *
 * ## Units are per-column, and they differ on purpose
 *
 * `timestamp` is UTC **seconds**: it is the wire field, Last.fm and ListenBrainz
 * both define it that way, and a millisecond value silently accepted as seconds
 * dates the scrobble to the year 56000. `next_attempt_at` is UTC **milliseconds**
 * because it is internal scheduling compared against `Date.now()`, like every
 * other timestamp Oscine stores. Both carry their unit in a comment here, since
 * a table with two time bases and one convention would be a table nobody can
 * read safely.
 *
 * ## No `CHECK` on `target`
 *
 * `kind` is a closed set of behaviours this code implements, so it is checked.
 * `target` is not: adding a target is a decision (an auth model, a batch limit,
 * a set of required fields) but it should not also be a schema migration, and a
 * `CHECK` here would mean a build that knows about a third service still cannot
 * queue for it until the database has caught up. The closed list lives in
 * `SCROBBLE_TARGET_IDS`, where the code that has to construct one can see it.
 *
 * ## The index
 *
 * `(target, next_attempt_at)` is exactly the drain worker's question: give me
 * this target's rows that are due. Targets drain independently, so `target`
 * leads; readiness is a range scan, so it follows.
 */
export const scrobbleOutbox: Migration = {
  version: 12,
  name: 'scrobble-outbox',
  sql: `
CREATE TABLE scrobble_queue (
  id                INTEGER PRIMARY KEY,
  target            TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('scrobble', 'love', 'unlove')),
  listen_id         INTEGER,
  track_id          INTEGER,
  artist_name       TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  album_title       TEXT,
  album_artist_name TEXT,
  duration_s        INTEGER,
  timestamp         INTEGER NOT NULL,  -- UTC seconds; the wire field, not ms
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL DEFAULT 0,  -- UTC ms; 0 means "due now"
  last_error        TEXT
);

CREATE INDEX idx_scrobble_queue_ready ON scrobble_queue(target, next_attempt_at);
`
}
