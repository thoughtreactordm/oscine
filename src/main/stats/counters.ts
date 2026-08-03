import type Database from 'better-sqlite3'
import type { RebuildCountersResult } from '@shared/stats'

/**
 * The counter rebuild: `tracks.play_count` and `tracks.last_played_at`, recomputed
 * from `listens` by full aggregation.
 *
 * These two columns have existed since migration 001 and were deliberately
 * unwritten until D17 gave them a definition. They are now **caches of the
 * listens log, not counters in their own right** — the distinction D11's
 * amendment names as its revisit trigger, and the reason the export bundle may
 * carry them at all. `ListenStore`'s transaction maintains them incrementally so
 * the common case costs no aggregation; this is the statement of what they are
 * supposed to be, and the repair when they are not.
 *
 * **If the cache and the log disagree, the log wins, without argument.** Nothing
 * here reads the current value except to decide whether a row needs writing. A
 * count that cannot be derived from `listens` is not a count worth keeping.
 *
 * First module under `main/stats/`; W10-9's query engine lands beside it. It is
 * a free function rather than a class because it prepares nothing worth holding
 * — one statement, run on demand at three known moments, never in a loop.
 */

/**
 * One grouped pass over `listens`, and a write only where the row is wrong.
 *
 * `LEFT JOIN` from `tracks` rather than grouping `listens` and joining back: the
 * rebuild has to *zero* a track whose listens are gone, and a derived table
 * built from `listens` alone has no row for it to zero with. `COUNT(l.id)`
 * rather than `COUNT(*)` for the same reason — over a `LEFT JOIN` miss,
 * `COUNT(*)` counts the unmatched row and every silent track would rebuild to
 * one play.
 *
 * Listens whose `track_id` is `NULL` — 014's `ON DELETE SET NULL`, a track that
 * left the library — join to nothing and contribute to no track's count. They
 * are still listens and every dashboard query still sees them; they are simply
 * not attributable to a row in `tracks`, which is exactly what the null means.
 *
 * The `IS NOT` predicate is what makes a rebuild over a consistent database a
 * no-op rather than a rewrite of every row. `IS NOT` and not `<>`, because both
 * columns are nullable and `<>` is `NULL` against a `NULL` — a track that has
 * never been played would compare unknown, fail the filter, and never be
 * repaired. It also makes `changes` an honest count of drift repaired, which is
 * the only number a repair action has worth reporting.
 */
const REBUILD_SQL = `
  UPDATE tracks AS t
  SET play_count     = agg.plays,
      last_played_at = agg.lastPlayed
  FROM (
    SELECT t2.id           AS id,
           COUNT(l.id)     AS plays,
           MAX(l.started_at) AS lastPlayed
    FROM tracks t2
    LEFT JOIN listens l ON l.track_id = t2.id
    GROUP BY t2.id
  ) AS agg
  WHERE t.id = agg.id
    AND (t.play_count IS NOT agg.plays OR t.last_played_at IS NOT agg.lastPlayed)
`

/**
 * Recomputes both counter columns for every track, and reports what it changed.
 *
 * Run it after a D11 import, after any migration that touches `listens`, and on
 * demand from Settings as a repair. All three are the same operation because
 * there is only one definition of what the columns mean; a cheaper incremental
 * repair would be a second definition, and the second one is the one that would
 * be wrong.
 *
 * Not wrapped in an explicit transaction: it is a single statement, and SQLite
 * gives a bare statement its own. Wrapping would only widen the window in which
 * the write lock is held.
 */
export function rebuildTrackCounters(db: Database.Database): RebuildCountersResult {
  const changed = db.prepare(REBUILD_SQL).run().changes
  const tracks = db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }
  const listens = db.prepare('SELECT COUNT(*) AS n FROM listens').get() as { n: number }
  return { tracksChanged: changed, tracksScanned: tracks.n, listensCounted: listens.n }
}
