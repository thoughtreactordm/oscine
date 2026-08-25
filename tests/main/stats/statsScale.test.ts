import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { StatsStore } from '../../../src/main/stats/store'
import type { StatsDimension, StatsRange, StatsRow, StatsSort } from '../../../src/shared/stats'
import { expectWithinBudget } from '../../support/perfBudget'

/**
 * The stats engine at scale (W10-10), and the measurement migration 014 defers
 * its index decision to.
 *
 * 014 leaves `artist_name`, `album_title` and `title` deliberately unindexed on
 * the grounds that the shape is *range first, group second* — `idx_listens_started`
 * serves the range and sorting one range's worth of rows is cheap. That is a
 * claim about a number, and this file is where the number comes from: a
 * generated log of 100,000 listens over four years, and a wall-clock budget on
 * every query shape against it. If the budgets here start failing, the three
 * rollup indexes are what to add — and by then there will be a measurement
 * saying so rather than a guess.
 *
 * The fixture is written straight into `listens`, in one transaction, for the
 * reason `statsQuery.test.ts` gives: a third of what it has to contain is rows
 * the commit path cannot produce.
 */

/** Deterministic, so a failing budget is a change in the engine and not in the data. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LISTENS = 100_000
const TRACKS = 3_000
const ARTISTS = 300
const ALBUMS = 900
const GENRES = 25

const YEAR = 365 * 86_400_000
const SPAN = 4 * YEAR
/** An arbitrary but fixed epoch, well clear of zero. 2021-01-01T00:00:00Z. */
const EPOCH = 1_609_459_200_000

interface Listen {
  trackId: number | null
  startedAt: number
  msListened: number
  title: string
  artist: string | null
  album: string | null
  albumArtist: string | null
  genres: string[]
}

let dir: string
let db: Database.Database
let store: StatsStore
let log: Listen[]

/**
 * The whole log, end to end. Assigned once the fixture exists rather than
 * declared from `SPAN`: the generator walks a random step per listen, so where
 * four years of it actually ends is data and not arithmetic — and a range
 * asserted to be wider than the log would quietly stop testing the upper bound.
 */
let FULL: StatsRange

/**
 * A library-shaped log rather than a uniform one.
 *
 * Three properties are deliberate. Listens are skewed towards a small set of
 * tracks, because a real top-10 is decided by a heavy tail and a uniform log
 * would make every ranking a near-tie that the tie-break, not the counts,
 * orders. A tenth of the rows carry `track_id IS NULL` — history whose track
 * has left the library, which every number here still has to count. And a
 * fiftieth carry no artist and no album, which the album and artist dimensions
 * have to drop while the track dimension keeps them.
 */
function generate(): Listen[] {
  const random = mulberry32(20260803)
  const listens: Listen[] = []

  // Distinct, increasing `started_at`: `idx_listens_identity` is unique over
  // (started_at, title, artist_name), and a generator that collided with it
  // would silently write fewer rows than it counted.
  let clock = EPOCH
  const step = Math.floor(SPAN / LISTENS)

  for (let index = 0; index < LISTENS; index += 1) {
    clock += 1 + Math.floor(random() * (2 * step - 1))

    // Squared, so the popular end of the library gets most of the plays.
    const trackIndex = Math.floor(random() * random() * TRACKS)
    const untagged = random() < 0.02
    const deleted = random() < 0.1
    // A tail of hour-long mixes among three-minute songs — the case the two
    // totals exist to tell apart.
    const msListened =
      random() < 0.03
        ? 2_400_000 + Math.floor(random() * 1_800_000)
        : 30_000 + Math.floor(random() * 270_000)

    const genres: string[] = []
    const genreCount = Math.floor(random() * 3)
    for (let g = 0; g < genreCount; g += 1) {
      const genre = `Genre ${Math.floor(random() * GENRES)}`
      if (!genres.includes(genre)) genres.push(genre)
    }

    listens.push({
      trackId: deleted ? null : trackIndex + 1,
      startedAt: clock,
      msListened,
      title: `Title ${trackIndex}`,
      artist: untagged ? null : `Artist ${trackIndex % ARTISTS}`,
      album: untagged ? null : `Album ${trackIndex % ALBUMS}`,
      albumArtist: untagged ? null : `Artist ${trackIndex % ARTISTS}`,
      genres
    })
  }

  return listens
}

function load(listens: readonly Listen[]): void {
  const rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 0).lastInsertRowid
  )

  // Tagged for real, unlike the listens above them — a scoped summary resolves
  // its seed's snapshot by joining these, so a fixture whose tracks carried a
  // title and nothing else would measure the scope against a `WHERE` that
  // matched only the untagged rows. Every album pairs with one album artist
  // because `ALBUMS` is a multiple of `ARTISTS`, which is what keeps the unique
  // index on `(title, album_artist_id)` satisfied by one row per album number.
  const insertArtist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)')
  const insertAlbum = db.prepare('INSERT INTO albums (id, title, album_artist_id) VALUES (?, ?, ?)')
  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, root_id, rel_path, mtime, size, title, artist_id, album_id, duration_ms)
     VALUES (?, ?, ?, 1, 2, ?, ?, ?, 200000)`
  )
  const insertListen = db.prepare(
    `INSERT INTO listens
       (track_id, started_at, ms_listened, duration_ms,
        title, artist_name, album_title, album_artist_name)
     VALUES (?, ?, ?, 200000, ?, ?, ?, ?)`
  )
  const insertGenre = db.prepare(
    'INSERT INTO listen_genres (listen_id, genre_key, genre) VALUES (?, ?, ?)'
  )

  db.transaction(() => {
    for (let index = 0; index < ARTISTS; index += 1) insertArtist.run(index + 1, `Artist ${index}`)
    for (let index = 0; index < ALBUMS; index += 1) {
      insertAlbum.run(index + 1, `Album ${index}`, (index % ARTISTS) + 1)
    }
    for (let index = 0; index < TRACKS; index += 1) {
      insertTrack.run(
        index + 1,
        rootId,
        `t${index}.flac`,
        `Title ${index}`,
        (index % ARTISTS) + 1,
        (index % ALBUMS) + 1
      )
    }
    for (const entry of listens) {
      const id = Number(
        insertListen.run(
          entry.trackId,
          entry.startedAt,
          entry.msListened,
          entry.title,
          entry.artist,
          entry.album,
          entry.albumArtist
        ).lastInsertRowid
      )
      for (const genre of entry.genres) insertGenre.run(id, genre.toLowerCase(), genre)
    }
  })()
}

const SEP = String.fromCharCode(31)
const NUL = String.fromCharCode(30)

interface Group {
  key: string
  label: string
  sublabel: string | null
  listens: number
  msListened: number
  trackId: number | null
}

/**
 * The oracle: the same four groupings, computed in JavaScript over the array
 * the fixture was generated from.
 *
 * A second implementation rather than a recorded expectation, because the
 * numbers under test are aggregates over a hundred thousand rows and a frozen
 * snapshot of them would only ever prove that nothing changed.
 */
function groupBy(listens: readonly Listen[], dimension: StatsDimension): Map<string, Group> {
  const groups = new Map<string, Group>()

  const add = (
    key: string,
    label: string,
    sublabel: string | null,
    entry: Listen,
    times: number
  ): void => {
    const existing = groups.get(key) ?? {
      key,
      label,
      sublabel,
      listens: 0,
      msListened: 0,
      trackId: null
    }
    existing.listens += times
    existing.msListened += entry.msListened * times
    if (entry.trackId !== null) {
      existing.trackId =
        existing.trackId === null ? entry.trackId : Math.max(existing.trackId, entry.trackId)
    }
    groups.set(key, existing)
  }

  for (const entry of listens) {
    if (dimension === 'track') {
      add(
        `${entry.title}${SEP}${entry.artist ?? NUL}${SEP}${entry.album ?? NUL}`,
        entry.title,
        entry.artist,
        entry,
        1
      )
    } else if (dimension === 'album') {
      if (entry.album === null) continue
      add(
        `${entry.album}${SEP}${entry.albumArtist ?? NUL}`,
        entry.album,
        entry.albumArtist,
        entry,
        1
      )
    } else if (dimension === 'artist') {
      if (entry.artist === null) continue
      add(entry.artist, entry.artist, null, entry, 1)
    } else {
      for (const genre of entry.genres) add(genre.toLowerCase(), genre, null, entry, 1)
    }
  }

  return groups
}

/** The engine's tie-break, restated: the secondary total, then the label. */
function rank(groups: Iterable<Group>, sort: StatsSort): Group[] {
  return [...groups].sort((a, b) => {
    const first = sort === 'listens' ? b.listens - a.listens : b.msListened - a.msListened
    if (first !== 0) return first
    const second = sort === 'listens' ? b.msListened - a.msListened : b.listens - a.listens
    if (second !== 0) return second
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
  })
}

function inRange(range: StatsRange): Listen[] {
  return log.filter((entry) => entry.startedAt >= range.from && entry.startedAt <= range.to)
}

/** Wall clock for one call, with the result thrown away. */
function timed(run: () => unknown): number {
  const started = performance.now()
  run()
  return performance.now() - started
}

/**
 * The two budgets, in milliseconds, and why they are two.
 *
 * As measured on a 2026 Linux laptop over this fixture — the numbers are
 * printed on every run, so the milestone evidence is the test output rather
 * than a comment someone has to remember to update:
 *
 * ```
 *   query track by listens         59 ms      summary               54 ms
 *   query album by listens         52 ms      overTime day × 4y     10 ms
 *   query artist by listens        41 ms      query track, 30d     1.2 ms
 *   query genre by listens         61 ms
 * ```
 *
 * **Whole-log queries are inherently a scan.** A range covering every row reads
 * every row whatever indexes exist, and the 40–60 ms above is the grouping, not
 * the lookup. `BUDGET_MS` is four times that: enough that a CI runner sharing a
 * core does not flake, tight enough to catch an accidental quadratic.
 *
 * **The narrow range is where an index is the difference**, and it is the
 * dashboard's ordinary case: 30 days out of four years is 1.2 ms because
 * `idx_listens_started` seeks straight to it — `EXPLAIN QUERY PLAN` reads
 * `SEARCH listens USING INDEX idx_listens_started`, then a temp b-tree for the
 * group. Lose that index and the same query becomes the 60 ms one. That is what
 * `NARROW_BUDGET_MS` is watching, and it is the reason 014 gets to keep leaving
 * `title`, `artist_name` and `album_title` unindexed: what the dashboard
 * actually asks costs a millisecond, and three indexes on the fastest-growing
 * table in the database would buy nothing that shows up here.
 */
const BUDGET_MS = 250
const NARROW_BUDGET_MS = 25

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-stats-scale-'))
  db = openDatabase(join(dir, 'library.db')).db
  store = new StatsStore(db)
  log = generate()
  load(log)
  FULL = { from: EPOCH, to: log[log.length - 1]!.startedAt }
}, 120_000)

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the generated log', () => {
  it('is the size the budgets below are stated against', () => {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM listens) AS listens,
                (SELECT COUNT(*) FROM listen_genres) AS genres,
                (SELECT COUNT(*) FROM listens WHERE track_id IS NULL) AS orphaned`
      )
      .get() as { listens: number; genres: number; orphaned: number }

    // Every generated row landed: a collision with `idx_listens_identity` would
    // show up here as a short table rather than as a wrong statistic later.
    expect(counts.listens).toBe(LISTENS)
    expect(counts.orphaned).toBeGreaterThan(LISTENS / 20)
    expect(counts.genres).toBeGreaterThan(LISTENS / 2)
  })
})

describe('StatsStore.query at scale', () => {
  const dimensions: StatsDimension[] = ['track', 'album', 'artist', 'genre']
  const sorts: StatsSort[] = ['listens', 'time']

  for (const dimension of dimensions) {
    for (const sort of sorts) {
      it(`ranks ${dimension} by ${sort} exactly as a second implementation does`, () => {
        const result = store.query({ range: FULL, dimension, sort, limit: 25, offset: 0 })
        const expected = rank(groupBy(inRange(FULL), dimension).values(), sort)

        expect(result.total).toBe(expected.length)
        expect(result.rows).toEqual(
          expected.slice(0, 25).map((group): StatsRow => ({
            key: group.key,
            label: group.label,
            sublabel: group.sublabel,
            listens: group.listens,
            msListened: group.msListened,
            trackId: group.trackId
          }))
        )
      })
    }
  }

  it('pages deep into a ranking without repeating or dropping a row', () => {
    const expected = rank(groupBy(inRange(FULL), 'artist').values(), 'listens')
    const page = store.query({
      range: FULL,
      dimension: 'artist',
      sort: 'listens',
      limit: 50,
      offset: 100
    })

    expect(page.rows.map((row) => row.key)).toEqual(
      expected.slice(100, 150).map((group) => group.key)
    )
  })

  /**
   * The narrow range is the dashboard's common case — "last 30 days" over a
   * log holding four years — and the one `idx_listens_started` exists for.
   */
  it('agrees with the oracle over a narrow range', () => {
    const range: StatsRange = { from: FULL.to - 30 * 86_400_000, to: FULL.to }
    const result = store.query({ range, dimension: 'track', sort: 'time', limit: 10, offset: 0 })
    const expected = rank(groupBy(inRange(range), 'track').values(), 'time')

    expect(result.total).toBe(expected.length)
    expect(result.rows.map((row) => row.key)).toEqual(
      expected.slice(0, 10).map((group) => group.key)
    )
  })
})

describe('StatsStore.summary at scale', () => {
  it('reports the totals and the distinct group counts the rankings do', () => {
    const summary = store.summary({ range: FULL, scope: null })
    const listens = inRange(FULL)

    expect(summary.listens).toBe(listens.length)
    expect(summary.msListened).toBe(listens.reduce((sum, entry) => sum + entry.msListened, 0))
    expect(summary.tracks).toBe(groupBy(listens, 'track').size)
    expect(summary.artists).toBe(groupBy(listens, 'artist').size)
    expect(summary.albums).toBe(groupBy(listens, 'album').size)
    expect(summary.firstListenAt).toBe(listens[0]?.startedAt)
    expect(summary.lastListenAt).toBe(listens.at(-1)?.startedAt)
  })

  /**
   * A multi-genre listen is one row in the log and one row under each of its
   * genres, which is why these two numbers differ — and why the summary reports
   * no genre count for the headline to disagree with.
   */
  it('counts a listen once overall however many genres it carries', () => {
    const genres = store.query({
      range: FULL,
      dimension: 'genre',
      sort: 'listens',
      limit: 200,
      offset: 0
    })
    const attributed = genres.rows.reduce((sum, row) => sum + row.listens, 0)

    expect(attributed).toBeGreaterThan(0)
    expect(store.summary({ range: FULL, scope: null }).listens).toBe(LISTENS)
    expect(attributed).not.toBe(LISTENS)
  })

  /**
   * The scoped summary against the oracle, on the seed the budget below times.
   *
   * Track 1 is `Title 0` by `Artist 0` on `Album 0`, and the log holds four
   * years of it — so this is the deck's ordinary case rather than a contrived
   * one. The untagged listens are what makes it worth asserting: they share no
   * artist and no album with the seed, and a scope written with `=` instead of
   * `IS` would silently fold them in or drop the group entirely.
   */
  it('scopes to the group the seed falls into, at four years of log', () => {
    const scoped = (by: 'track' | 'album' | 'artist'): number =>
      store.summary({ range: FULL, scope: { trackId: 1, by } }).listens

    const listens = inRange(FULL)
    expect(scoped('track')).toBe(
      listens.filter(
        (entry) =>
          entry.title === 'Title 0' && entry.artist === 'Artist 0' && entry.album === 'Album 0'
      ).length
    )
    expect(scoped('album')).toBe(
      listens.filter((entry) => entry.album === 'Album 0' && entry.albumArtist === 'Artist 0')
        .length
    )
    expect(scoped('artist')).toBe(listens.filter((entry) => entry.artist === 'Artist 0').length)
    expect(scoped('artist')).toBeGreaterThan(scoped('album'))
    expect(scoped('album')).toBeGreaterThan(scoped('track'))
  })
})

describe('StatsStore.overTime at scale', () => {
  it('draws a dense daily series across four years that sums to the whole log', () => {
    const series = store.overTime({ range: FULL, bucket: 'day' })

    expect(series.points).toHaveLength(Math.floor((FULL.to - FULL.from) / 86_400_000) + 1)
    expect(series.points.reduce((sum, point) => sum + point.listens, 0)).toBe(LISTENS)
    expect(series.points.reduce((sum, point) => sum + point.msListened, 0)).toBe(
      log.reduce((sum, entry) => sum + entry.msListened, 0)
    )
  })

  it('buckets a week of hours with every bucket present', () => {
    const range: StatsRange = { from: EPOCH, to: EPOCH + 7 * 86_400_000 }
    const series = store.overTime({ range, bucket: 'hour' })
    const expected = inRange(range)

    expect(series.points).toHaveLength(7 * 24 + 1)
    expect(series.points.reduce((sum, point) => sum + point.listens, 0)).toBe(expected.length)
  })
})

/**
 * The measurement W10-10 is done when, and 014's deferred index decision.
 *
 * Reported as one table on every run. A budget breach names the shape that
 * broke it, because a single "stats are slow" failure would send the next
 * reader back to measuring it themselves.
 */
describe('the time budget', () => {
  it('answers every query shape over four years inside the budget', () => {
    interface Measurement {
      label: string
      ms: number
      budget: number
    }
    const measurements: Measurement[] = []
    const measure = (label: string, budget: number, run: () => unknown): void => {
      measurements.push({ label, budget, ms: timed(run) })
    }

    for (const dimension of ['track', 'album', 'artist', 'genre'] as StatsDimension[]) {
      for (const sort of ['listens', 'time'] as StatsSort[]) {
        measure(`query ${dimension} by ${sort}`, BUDGET_MS, () =>
          store.query({ range: FULL, dimension, sort, limit: 25, offset: 0 })
        )
      }
    }

    measure('summary', BUDGET_MS, () => store.summary({ range: FULL, scope: null }))
    measure('overTime day × 4y', BUDGET_MS, () => store.overTime({ range: FULL, bucket: 'day' }))

    // The Tunedeck's three, over all time — which is the only range it asks for
    // and therefore the worst case rather than a stress test. Held to the same
    // budget as the whole-log shapes, and fired on every track change rather
    // than on opening a dashboard, so this is the number to watch if the deck
    // ever feels like it lags the transport.
    for (const by of ['track', 'album', 'artist'] as const) {
      measure(`summary scoped to ${by}`, BUDGET_MS, () =>
        store.summary({ range: FULL, scope: { trackId: 1, by } })
      )
    }

    // The one the index decision turns on, and the only one held to the tight
    // budget. It is also what the dashboard opens on.
    measure('query track by listens, 30d', NARROW_BUDGET_MS, () =>
      store.query({
        range: { from: FULL.to - 30 * 86_400_000, to: FULL.to },
        dimension: 'track',
        sort: 'listens',
        limit: 25,
        offset: 0
      })
    )

    console.info(
      `\n  stats engine — ${LISTENS.toLocaleString('en-US')} listens, ${TRACKS} tracks, 4 years\n` +
        measurements
          .map(
            ({ label, ms, budget }) =>
              `    ${label.padEnd(30)} ${ms.toFixed(1).padStart(6)} ms   (budget ${budget} ms)`
          )
          .join('\n') +
        '\n'
    )

    for (const { label, ms, budget } of measurements) {
      expectWithinBudget(ms, budget, label)
    }
  })
})
