import type Database from 'better-sqlite3'
import {
  STATS_BUCKET_MS,
  type StatsDimension,
  type StatsOverTimePoint,
  type StatsOverTimeQuery,
  type StatsOverTimeResult,
  type StatsQuery,
  type StatsQueryResult,
  type StatsRange,
  type StatsRow,
  type StatsSort,
  type StatsSummary
} from '@shared/stats'

/**
 * The stats engine: one query shape, four dimensions, two totals.
 *
 * Every statistic Fermata reports is the same sentence — *filter `listens` by a
 * time range, group by a dimension, order by count or by summed `ms_listened`*
 * — so it is written once here and parametrised, rather than four times in four
 * channels that would agree on the day they were written and not afterwards.
 *
 * ## It never joins back to the library
 *
 * Not once, in any dimension. The grouping columns are the snapshots migration
 * 014 writes onto every row, and `listen_genres` is the genre snapshot. That is
 * D17 kept rather than restated: a listen whose track has been deleted has
 * `track_id IS NULL` and every number here still counts it, and re-tagging an
 * album next year cannot reach backwards and change what the year before said.
 *
 * The one place a track id appears is `MAX(track_id)` — a *link*, not a
 * grouping key, and null when the group has no surviving track.
 *
 * ## The indexes it does and does not use
 *
 * `idx_listens_started` serves the range; nothing serves the grouping, because
 * 014 leaves `artist_name`, `album_title` and `title` deliberately unindexed.
 * The shape is range-first and group-second, so the sort runs over one range's
 * worth of rows rather than the table. Whether that holds at scale is not an
 * opinion — `tests/main/stats/statsScale.test.ts` measures it against a
 * generated log of 100,000 listens and holds it to a budget, and 014's note
 * defers the index decision to exactly that number.
 */

/** Separates the parts of a composite `StatsRow.key`. Unit separator, U+001F. */
const KEY_SEP = 'char(31)'

/** Stands in for a null part, so two nulls in different places cannot collide. */
const KEY_NULL = 'char(30)'

/**
 * How one dimension groups, as the fragments the two statements below share.
 *
 * `filter` drops rows the dimension has nothing to say about: a listen with no
 * `album_title` is not an album anyone listened to, and folding those rows into
 * one nameless group would put a row in the top-albums list that no click can
 * ever open. `title` is `NOT NULL` on the table — 014 makes attribution the
 * condition of writing a row at all — so the track dimension needs no filter
 * and sees every listen in range.
 */
interface DimensionSql {
  /** `FROM` clause, including the join the genre dimension needs. */
  readonly source: string
  /** Qualified `started_at`, `ms_listened` and `track_id` for that source. */
  readonly time: string
  readonly ms: string
  readonly track: string
  /** The row's opaque identity, and what it says. */
  readonly key: string
  readonly label: string
  readonly sublabel: string
  readonly groupBy: string
  /** Appended to the range predicate; `''` for dimensions that filter nothing. */
  readonly filter: string
}

const DIMENSIONS: Readonly<Record<StatsDimension, DimensionSql>> = {
  // Title, artist and album together, rather than title alone: a live version
  // and a studio version are two things the operator listened to, and the
  // snapshot is all there is to tell them apart. The cost is the mirror image —
  // one track that appears on both an album and a compilation ranks as two —
  // and it is the lesser of the two, because that pair at least names two real
  // rows in the library while a merged one names neither.
  track: {
    source: 'listens',
    time: 'started_at',
    ms: 'ms_listened',
    track: 'track_id',
    key: `title || ${KEY_SEP} || COALESCE(artist_name, ${KEY_NULL}) || ${KEY_SEP} || COALESCE(album_title, ${KEY_NULL})`,
    label: 'title',
    sublabel: 'artist_name',
    groupBy: 'title, artist_name, album_title',
    filter: ''
  },
  // Grouped with the *album* artist and not with `artist_name`, and not
  // coalescing one to the other. A compilation whose rows carry no album artist
  // is one album with many artists on it; coalescing would shatter it into one
  // row per performer, each claiming to be an album.
  album: {
    source: 'listens',
    time: 'started_at',
    ms: 'ms_listened',
    track: 'track_id',
    key: `album_title || ${KEY_SEP} || COALESCE(album_artist_name, ${KEY_NULL})`,
    label: 'album_title',
    sublabel: 'album_artist_name',
    groupBy: 'album_title, album_artist_name',
    filter: ' AND album_title IS NOT NULL'
  },
  artist: {
    source: 'listens',
    time: 'started_at',
    ms: 'ms_listened',
    track: 'track_id',
    key: 'artist_name',
    label: 'artist_name',
    sublabel: 'NULL',
    groupBy: 'artist_name',
    filter: ' AND artist_name IS NOT NULL'
  },
  // The only dimension with a join, and it is to the genre snapshot rather than
  // to `track_genres` — the same reason every other dimension reads a snapshot,
  // plus one: `listen_genres` is keyed by `(listen_id, genre_key)`, so the range
  // scan probes it by rowid-equivalent and never splits a string.
  //
  // A listen with two genres contributes a row to each, which is the intent:
  // "top genres" counts a jazz-funk record under both. It is also why the
  // dimension totals do not sum to `summary.listens`, and why the summary
  // reports no genre count.
  //
  // `MAX(genre)` picks one spelling out of however many the group holds. It is
  // arbitrary but stable, and stability is the property that matters for a
  // label — choosing the most frequent spelling instead would be a second
  // aggregation over the same rows to decide a display detail.
  genre: {
    source: 'listen_genres g JOIN listens l ON l.id = g.listen_id',
    time: 'l.started_at',
    ms: 'l.ms_listened',
    track: 'l.track_id',
    key: 'g.genre_key',
    label: 'MAX(g.genre)',
    sublabel: 'NULL',
    groupBy: 'g.genre_key',
    filter: ''
  }
}

/**
 * The tie-break is what makes paging honest.
 *
 * Two groups with equal counts have no inherent order, and SQLite is free to
 * return them either way on either call — so without a deterministic tail, page
 * two of a top list can repeat a row from page one and drop another entirely.
 * The secondary total breaks most ties and the label breaks the rest.
 */
const ORDER: Readonly<Record<StatsSort, string>> = {
  listens: 'listens DESC, msListened DESC, label ASC',
  time: 'msListened DESC, listens DESC, label ASC'
}

const RANGE = (d: DimensionSql): string => `${d.time} >= @from AND ${d.time} <= @to${d.filter}`

function rowsSql(dimension: StatsDimension, sort: StatsSort): string {
  const d = DIMENSIONS[dimension]
  return `
    SELECT ${d.key}                     AS key,
           ${d.label}                   AS label,
           ${d.sublabel}                AS sublabel,
           COUNT(*)                     AS listens,
           COALESCE(SUM(${d.ms}), 0)    AS msListened,
           MAX(${d.track})              AS trackId
    FROM ${d.source}
    WHERE ${RANGE(d)}
    GROUP BY ${d.groupBy}
    ORDER BY ${ORDER[sort]}
    LIMIT @limit OFFSET @offset
  `
}

/**
 * The group count, over the same range and the same grouping.
 *
 * A derived table rather than `COUNT(DISTINCT …)`: the composite dimensions
 * group on two and three columns, and expressing that as one distinct
 * expression would mean concatenating them — which is a second definition of
 * the grouping, in the one query whose job is to agree with the first.
 */
function totalSql(dimension: StatsDimension): string {
  const d = DIMENSIONS[dimension]
  return `
    SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM ${d.source} WHERE ${RANGE(d)} GROUP BY ${d.groupBy}
    )
  `
}

/**
 * Distinct *snapshot tuples*, not distinct ids, and filtered exactly as the
 * matching dimension filters.
 *
 * That equality is the point: `summary.artists` is the number of rows the
 * top-artists list would page through, so the two can sit on one screen without
 * contradicting each other. Counting distinct `artist_id` instead would give a
 * smaller, differently-wrong number that silently omits every artist whose
 * tracks have left the library.
 */
const SUMMARY_SQL = `
  SELECT
    (SELECT COUNT(*) FROM listens WHERE started_at >= @from AND started_at <= @to)
      AS listens,
    (SELECT COALESCE(SUM(ms_listened), 0) FROM listens
      WHERE started_at >= @from AND started_at <= @to)
      AS msListened,
    (SELECT COUNT(*) FROM (
       SELECT DISTINCT title, artist_name, album_title FROM listens
       WHERE started_at >= @from AND started_at <= @to))
      AS tracks,
    (SELECT COUNT(*) FROM (
       SELECT DISTINCT artist_name FROM listens
       WHERE started_at >= @from AND started_at <= @to AND artist_name IS NOT NULL))
      AS artists,
    (SELECT COUNT(*) FROM (
       SELECT DISTINCT album_title, album_artist_name FROM listens
       WHERE started_at >= @from AND started_at <= @to AND album_title IS NOT NULL))
      AS albums,
    (SELECT MIN(started_at) FROM listens WHERE started_at >= @from AND started_at <= @to)
      AS firstListenAt,
    (SELECT MAX(started_at) FROM listens WHERE started_at >= @from AND started_at <= @to)
      AS lastListenAt
`

/**
 * Bucketing is integer division from `from`, in SQL, over the range index.
 *
 * No `strftime`, no `unixepoch`, no `localtime` — a calendar function here is a
 * calendar function running in whichever timezone the main process happens to
 * be in, which is the thing `StatsRange` exists to keep out. Division has no
 * timezone; the alignment comes from `from`, which the renderer set to local
 * midnight because it is the side that knows where midnight is.
 *
 * Empty buckets are absent from this result and filled in afterwards. Making
 * SQLite generate the dense series would mean a recursive CTE joined to the
 * aggregate, which is more machinery than a loop over an array the caller has
 * already sized.
 *
 * **The casts are load-bearing.** better-sqlite3 binds a JavaScript number as
 * REAL whether or not it is integral, and `/` in SQLite is integer division
 * only when *both* operands are INTEGER. Without them every bucket index comes
 * back a fraction — `0.9999997222` and `2.0000013889` — each its own group, so
 * the series silently becomes one point per listen. It reads as a chart with a
 * gap rather than as an error, which is why it is spelled out here.
 */
const OVER_TIME_SQL = `
  SELECT (started_at - CAST(@from AS INTEGER)) / CAST(@width AS INTEGER) AS bucket,
         COUNT(*)                      AS listens,
         COALESCE(SUM(ms_listened), 0) AS msListened
  FROM listens
  WHERE started_at >= @from AND started_at <= @to
  GROUP BY bucket
  ORDER BY bucket
`

interface RankedRow {
  key: string
  label: string
  sublabel: string | null
  listens: number
  msListened: number
  trackId: number | null
}

interface BucketRow {
  bucket: number
  listens: number
  msListened: number
}

/**
 * Reads only. It holds no transaction and takes no lock a reader does not
 * already take, so a dashboard left open cannot block the scanner.
 *
 * Statements are prepared on first use rather than in the constructor: the
 * dimension/sort space is sixteen statements, and an operator who never opens
 * the dashboard should pay for none of them.
 */
export class StatsStore {
  private readonly db: Database.Database
  private readonly cache = new Map<string, Database.Statement>()

  constructor(db: Database.Database) {
    this.db = db
  }

  private prepared(key: string, sql: string): Database.Statement {
    const existing = this.cache.get(key)
    if (existing) return existing
    const statement = this.db.prepare(sql)
    this.cache.set(key, statement)
    return statement
  }

  query(request: StatsQuery): StatsQueryResult {
    const { range, dimension, sort, limit, offset } = request
    const rows = this.prepared(`rows:${dimension}:${sort}`, rowsSql(dimension, sort)).all({
      from: range.from,
      to: range.to,
      limit,
      offset
    }) as RankedRow[]

    const { total } = this.prepared(`total:${dimension}`, totalSql(dimension)).get({
      from: range.from,
      to: range.to
    }) as { total: number }

    return {
      dimension,
      sort,
      total,
      rows: rows.map((row): StatsRow => ({
        key: row.key,
        label: row.label,
        sublabel: row.sublabel,
        listens: row.listens,
        msListened: row.msListened,
        trackId: row.trackId
      }))
    }
  }

  summary(range: StatsRange): StatsSummary {
    const row = this.prepared('summary', SUMMARY_SQL).get({
      from: range.from,
      to: range.to
    }) as Omit<StatsSummary, 'range'>

    return { range, ...row }
  }

  overTime(request: StatsOverTimeQuery): StatsOverTimeResult {
    const { range, bucket } = request
    const width = STATS_BUCKET_MS[bucket]
    const rows = this.prepared('overTime', OVER_TIME_SQL).all({
      from: range.from,
      to: range.to,
      width
    }) as BucketRow[]

    // `+ 1` because the range is closed at both ends: a `to` that lands exactly
    // on a bucket boundary is a listen that belongs in that bucket, so the
    // series has to reach it. `MAX_STATS_BUCKETS` has already been enforced at
    // the boundary against this same arithmetic.
    const count = Math.floor((range.to - range.from) / width) + 1
    const byIndex = new Map(rows.map((row) => [row.bucket, row]))
    const points: StatsOverTimePoint[] = []
    for (let index = 0; index < count; index += 1) {
      const row = byIndex.get(index)
      points.push({
        startedAt: range.from + index * width,
        listens: row?.listens ?? 0,
        msListened: row?.msListened ?? 0
      })
    }

    return { range, bucket, points }
  }
}
