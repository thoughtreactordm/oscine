/**
 * The statistics surface — **D17**.
 *
 * Everything Fermata reports about listening is a query over the `listens` log
 * (migration 014). This file starts with the one operation that is not a query:
 * the rebuild of the two counter columns that cache it. W10-9's `stats.query`,
 * `stats.summary` and `stats.overTime` join it here.
 *
 * ## `tracks.play_count` and `tracks.last_played_at` are caches
 *
 * Migration 001 created them; D17 gave them a definition. They hold what a full
 * aggregation over `listens` would compute, and the listen commit maintains them
 * inside the same transaction that writes the log row, so the two cannot part
 * company through the ordinary path. They exist because sorting a hundred
 * thousand tracks by play count cannot be a `GROUP BY` over the largest table in
 * the database on every keystroke.
 *
 * They are a cache in the strict sense: **losing them costs nothing but time.**
 * That is the property D11's amendment turns on — the export bundle carries a
 * play count as a statement about a track, and it is only honest to merge one
 * machine's count into another's if the number is derived rather than
 * accumulated. And it is what makes them safe to be wrong: a bug, an interrupted
 * write or a hand-edited database is repaired by recomputation, not by
 * archaeology.
 *
 * **If the cache and the log disagree, the log wins, without argument.**
 */

/**
 * What a rebuild did.
 *
 * `tracksChanged` is the count of rows whose cached value actually differed —
 * the rebuild writes only where it has to. It is therefore a measure of drift:
 * zero on a healthy database is the design working, and the repair action in
 * Settings says so rather than claiming to have fixed something. The other two
 * are context for that number, because "0 changed" means one thing over a
 * populated library and another over an empty one.
 */
export interface RebuildCountersResult {
  /** Rows whose `play_count` or `last_played_at` was wrong and has been fixed. */
  readonly tracksChanged: number
  /** Tracks considered. Every track is, always — there is no partial rebuild. */
  readonly tracksScanned: number
  /** Rows in the log the counts were derived from, attributable or not. */
  readonly listensCounted: number
}
