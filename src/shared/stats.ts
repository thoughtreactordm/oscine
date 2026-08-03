/**
 * The statistics surface — **D17**.
 *
 * Everything Fermata reports about listening is a query over the `listens` log
 * (migration 014). It opens with the one operation that is not a query — the
 * rebuild of the two counter columns that cache the log — and continues with
 * the three that are: `stats.query`, `stats.summary` and `stats.overTime`.
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

/**
 * The window every statistic is computed over: a **closed** interval in UTC ms.
 *
 * Closed at both ends — a listen whose `started_at` is exactly `from`, and one
 * exactly `to`, are both in. Half-open would be the more usual choice and is
 * wrong here for one reason: these bounds are computed by the renderer from a
 * preset, so the two ends are not symmetric in how they are produced, and a
 * rule that says "inclusive" needs no arithmetic on either.
 *
 * **A range, not a named preset.** "This year" and "the last 7 days" are
 * questions about the operator's calendar, and resolving them requires their
 * timezone and their idea of when a year starts. The renderer has both from the
 * platform; main would have to be told, and a main process that has been told
 * the timezone is one that can be told the wrong timezone. So the presets live
 * where the clock does, and what crosses the boundary is two integers.
 */
export interface StatsRange {
  /** UTC ms, inclusive. */
  readonly from: number
  /** UTC ms, inclusive. Must be `>= from`. */
  readonly to: number
}

/**
 * The range that holds the whole log, for a surface with no date picker.
 *
 * The Tunedeck's range. A play count on a deck is not a question about a
 * window — "42 plays" means since you have owned it — so the surface that would
 * have to resolve a preset does not have one to resolve, and this is what it
 * sends instead.
 *
 * `to` is `MAX_SAFE_INTEGER` rather than the caller's clock. A `to` of *now*
 * would silently drop a listen whose `started_at` is ahead of it, which is not
 * a hypothetical: a machine whose clock was corrected backwards has rows in its
 * future, and a play count that quietly omits them is worse than one that
 * includes a row it cannot explain. Nothing in the closed-range contract makes
 * an upper bound past the end of the log cost anything — the scan is the log.
 */
export const ALL_TIME: StatsRange = { from: 0, to: Number.MAX_SAFE_INTEGER }

/**
 * What a ranking groups by.
 *
 * Four dimensions and one query shape, rather than four near-identical
 * channels: every one of them is "filter by range, group, order, page", and
 * writing that four times is writing four places for it to drift.
 *
 * The first three group on the **snapshot columns** of `listens` — `title`,
 * `artist_name`, `album_title`, `album_artist_name` — and never on a join back
 * to `tracks`/`artists`/`albums`. That is D17's whole point: a deleted track's
 * history still counts, and correcting a tag next year does not silently
 * rewrite what last year said. The accepted cost is that a genuine tag *fix*
 * leaves the same artist in the list twice under two spellings; re-attributing
 * historical rows is a recorded debt, not something a query can decide.
 *
 * `genre` groups through `listen_genres.genre_key`, written at listen time by
 * copying `track_genres`, for the same reason and one more: it makes "top
 * genres" an indexed join rather than a string split over every row in range.
 */
export type StatsDimension = 'track' | 'album' | 'artist' | 'genre'

export const STATS_DIMENSIONS = ['track', 'album', 'artist', 'genre'] as const

/**
 * Which of the two totals the ranking is ordered by.
 *
 * **Both totals are always returned; only the order is chosen.** For a library
 * that mixes three-minute songs with hour-long mixes the two tell genuinely
 * different stories, and a top list that reported one of them would be picking
 * a side on the operator's behalf.
 *
 * Required rather than defaulted, which is the one place this contract departs
 * from the card's four-field spelling. A default would be exactly the choice
 * the paragraph above refuses to make — and it cannot be resolved renderer-side
 * the way the range presets are, because `limit`/`offset` mean nothing until
 * something has decided what "top" means.
 */
export type StatsSort = 'listens' | 'time'

export const STATS_SORTS = ['listens', 'time'] as const

/**
 * One ranked group.
 *
 * `key` is the group's identity within a dimension — `genre_key` for genres,
 * and the snapshot columns joined by a separator for the other three. It is a
 * list key and a selection identity, not something to parse: what a row *says*
 * is in `label` and `sublabel`, already split.
 */
export interface StatsRow {
  /** Stable within a dimension and a range. Opaque — do not parse it. */
  readonly key: string
  /** Track title, album title, artist name, or one spelling of the genre. */
  readonly label: string
  /** The artist under a track or album row; `null` for artist and genre rows. */
  readonly sublabel: string | null
  /** Rows in `listens`. A multi-genre listen counts once under each of its genres. */
  readonly listens: number
  /** Summed `ms_listened` over those rows. */
  readonly msListened: number
  /**
   * A surviving track from this group, or `null` when none is left.
   *
   * What the dashboard clicks through on — every seeded read in this app takes
   * a track id, so an artist row that carries one can open the artist without
   * the dashboard first having to resolve one. `null` is the ordinary answer
   * for history whose tracks have left the library, and the UI renders it as a
   * row that does not click rather than treating it as an error.
   *
   * Which surviving track is unspecified beyond "one of them". The id points at
   * a row in `tracks` as it reads *now*, which for a corrected tag is not
   * necessarily what this row's snapshot says — the same D17 trade the grouping
   * makes, seen from the other end.
   */
  readonly trackId: number | null
}

export interface StatsQuery {
  readonly range: StatsRange
  readonly dimension: StatsDimension
  readonly sort: StatsSort
  readonly limit: number
  readonly offset: number
}

export interface StatsQueryResult {
  /** Echoed, so a reply that outran a dimension switch can be discarded. */
  readonly dimension: StatsDimension
  /** Echoed, for the same reason. */
  readonly sort: StatsSort
  readonly rows: StatsRow[]
  /**
   * Distinct groups in range, ignoring `limit` and `offset`.
   *
   * A top list is not a virtualized table and does not need this for a
   * scrollbar; it needs it to know whether "show more" exists at all, and to
   * say "top 10 of 431" rather than "top 10". It costs a second pass over the
   * same range, which is why it is one number and not a second query.
   */
  readonly total: number
}

/**
 * The ceiling on one page of ranked rows.
 *
 * Far below the track-page ceilings, and deliberately: these rows are read by a
 * human off a dashboard, not scrolled through, and nothing in the design pages
 * deeply into them. A caller wanting the whole distribution wants a different
 * feature — W10-14's retrospective — and it should have to say so.
 */
export const MAX_STATS_ROWS = 200

/**
 * Which of the groups around one track a summary is narrowed to.
 *
 * Not a fifth `StatsDimension`, and the distinction is worth keeping straight:
 * a dimension says what the rows are *grouped by*, and this says which rows
 * there are at all. The dashboard asks the whole log for its headline numbers;
 * the Tunedeck asks one group for the same seven, which is the same question
 * with a narrower `WHERE` rather than a different query.
 *
 * The three names are the three dimensions that group on snapshot columns, and
 * a scope is exactly the group the seed track falls into for that dimension —
 * so a scoped `listens` is the number the matching ranking reports on the seed's
 * row. That equality is the point, the same way `summary.artists` equals the
 * top-artists `total`: the deck and the dashboard cannot disagree on screen.
 *
 * **There is no `genre` scope.** A track carries several genres, so "the group
 * this track falls into" is not one group for that dimension, and a scope whose
 * honest answer is a set of totals rather than one is a different question.
 * `stats.query` with the genre dimension is where that one is already asked.
 */
export type StatsScopeBy = 'track' | 'album' | 'artist'

export const STATS_SCOPE_BYS = ['track', 'album', 'artist'] as const

/**
 * A scope, named by a track id rather than by the values it matches on.
 *
 * **The renderer sends an id; main resolves the snapshot tuple**, with the same
 * override-resolving `SELECT` the listen commit uses to *write* one. That is the
 * load-bearing decision here rather than a convenience. The alternative — the
 * renderer sending the title, artist and album off the `Track` it is already
 * holding — puts a second copy of "how an override resolves" on the far side of
 * the boundary, and the day the two copies disagree is the day the deck reports
 * no plays for a track with a decade of history and gives no sign why.
 *
 * Matching is on the snapshots, so this inherits D17 whole and inherits its
 * accepted cost with it: history recorded under a previous spelling is not
 * counted here, exactly as it is not merged in the rankings.
 */
export interface StatsScope {
  readonly trackId: number
  readonly by: StatsScopeBy
}

export interface StatsSummaryQuery {
  readonly range: StatsRange
  /** `null` for the whole log — the dashboard's headline numbers. */
  readonly scope: StatsScope | null
}

/**
 * Seven numbers over one range, either for the whole log or for one group.
 *
 * The three counts are **distinct groups**, computed the same way the rankings
 * group: distinct snapshot tuples, not distinct ids. So a track that has since
 * left the library still counts as a track listened to, and two spellings of
 * one artist count as two — the same number the top-artists list would show a
 * length of, which is the only way the two can be shown on one screen without
 * contradicting each other.
 *
 * No genre count. It is the one dimension that needs the join, and a headline
 * number is not worth a fifth pass; the top-genres list carries a `total` that
 * says it for anyone who asks.
 *
 * Under a scope the same three keep meaning what they meant, which is what makes
 * them worth keeping rather than zeroing: scoped to an artist, `albums` is how
 * many of their records you have put on and `tracks` is how many of their songs
 * — two sentences the deck gets for no query it was not already running.
 */
export interface StatsSummary {
  /** Echoed, so a reply that outran a range change can be discarded. */
  readonly range: StatsRange
  /** Echoed, for the same reason — a reply that outran a track change. */
  readonly scope: StatsScope | null
  /**
   * Whether the scope named a group at all. Always `true` when unscoped.
   *
   * `false` is *there is nothing here to ask about*, and it is a different fact
   * from every number being zero, which is *you have not played it yet*. A seed
   * that has left the library lands here, and so does one that names no album
   * when the album is what was asked for. A freshly scanned track does not: it
   * resolves, and answers zero. Two facts, two sentences — a zero is a real
   * answer and the surface that shows one should not be able to mistake it for
   * an empty panel.
   */
  readonly resolved: boolean
  /** Rows in range. A multi-genre listen counts once, here. */
  readonly listens: number
  readonly msListened: number
  readonly tracks: number
  readonly artists: number
  readonly albums: number
  /** `started_at` of the earliest listen in range, or `null` when there are none. */
  readonly firstListenAt: number | null
  readonly lastListenAt: number | null
}

/**
 * A bucket width for the over-time series.
 *
 * All three are **fixed widths anchored at `range.from`** — bucket `n` covers
 * `[from + n·width, from + (n+1)·width)`. That is what keeps main free of the
 * operator's calendar while still drawing a chart aligned to their days: the
 * renderer already resolves the preset, so it hands over a `from` that is local
 * midnight, and every day boundary after it falls where they expect.
 *
 * **There is no `month` or `year`**, and their absence is the same decision.
 * Calendar months are not a fixed width, so bucketing by them would require
 * main to know which timezone's months, which is precisely what `StatsRange`
 * exists to avoid. A renderer that wants calendar months asks for `day` and
 * folds the points itself, where the calendar is.
 *
 * A week starts on whatever weekday `from` is, for the same reason — "weeks
 * start on Monday" is a locale fact and this side of the boundary does not hold
 * one.
 */
export type StatsBucket = 'hour' | 'day' | 'week'

export const STATS_BUCKETS = ['hour', 'day', 'week'] as const

export const STATS_BUCKET_MS: Readonly<Record<StatsBucket, number>> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000
}

/**
 * The most buckets one series may carry.
 *
 * The bound is on the *product* of range and width rather than on either alone,
 * because that product is the size of the response and the width of the chart:
 * hourly buckets over a decade is 87,600 points through a structured clone to
 * draw a line 1,900 pixels wide. Refused rather than clamped, like every other
 * ceiling at this boundary — a caller asking for it has a wrong belief about
 * what it will get back, and truncating the series silently leaves that belief
 * in place while drawing a chart that stops in 2019 for no visible reason.
 *
 * Daily buckets over ten years fit inside it, which is the longest series the
 * dashboard's presets can produce.
 */
export const MAX_STATS_BUCKETS = 4000

export interface StatsOverTimeQuery {
  readonly range: StatsRange
  readonly bucket: StatsBucket
}

export interface StatsOverTimePoint {
  /** UTC ms of the bucket's start — `from + n·width`, not the first listen in it. */
  readonly startedAt: number
  readonly listens: number
  readonly msListened: number
}

export interface StatsOverTimeResult {
  /** Echoed, so a reply that outran a range change can be discarded. */
  readonly range: StatsRange
  /** Echoed, for the same reason. */
  readonly bucket: StatsBucket
  /**
   * Every bucket in range, in order, **including the empty ones**.
   *
   * A series that omitted silent days would be drawn as a line straight across
   * them, which reads as steady listening through a week the operator was away.
   * Zeros are the honest shape and `MAX_STATS_BUCKETS` is what makes sending
   * them affordable.
   */
  readonly points: StatsOverTimePoint[]
}
