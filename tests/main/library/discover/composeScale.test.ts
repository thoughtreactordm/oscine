import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../../src/main/db'
import { compose } from '../../../../src/main/library/discover/compose'
import { DAY_MS } from '../../../../src/main/library/discover/constants'
import { expectWithinBudget } from '../../../support/perfBudget'
import { NOW } from './fixture'

/**
 * compose at the 100k-track scale target, same spirit as W10-10.
 *
 * Discover opens on a tab, not on a track change, and the result is memoized
 * against the day and the log, so this is not the deck's 16.7 ms frame budget.
 * If it misses that frame it is a card (add rollup indexes), not a silent
 * `RANDOM() LIMIT 10`. The number written down here is the one that card
 * would have to beat.
 */

const TRACK_COUNT = 100_000
const ARTISTS = 2_000
const ALBUMS = 8_000
const GENRES = 5

/**
 * Tab-open budget. W12-6's genre-roulette briefly pushed this past 250 ms — its
 * pool gate had to scan the whole library's genre map, ~35 ms at this 100k
 * ceiling — so the budget went to 300 with W12-8 named as the number to beat.
 * W12-8 denormalized `album_id` onto `track_genres` and its covering
 * `(genre_key, album_id)` index turned that scan into an index-only walk, and
 * the budget was set back to 250.
 *
 * 250 turned out to be the measured cost rather than a budget, which is not a
 * threshold so much as a coin toss. The ten recipes divide the work evenly at
 * this fixture — no hotspot, `unplayed` 52 ms and `for-you` 45 ms at the top,
 * ~245 ms in total on an idle 16-core desktop — so there is no cheap win hiding
 * here and nothing has regressed; the number was simply set flush against
 * reality. Run-to-run spread is ~15 ms, and Vitest saturates every core with
 * other files while this one measures, which costs ~10 ms more.
 *
 * So: 320, about 20% clear of the loaded p95. That is deliberately a
 * catch-the-quadratic budget rather than a catch-the-creep one. A measurement
 * with ±15 ms of noise cannot honestly police a 35 ms regression, and pretending
 * otherwise is what produced a test that failed half the time for no reason. If
 * Discover needs defending at that resolution it wants a benchmark on a quiet
 * machine, not an assertion inside the unit suite.
 *
 * Compose is memoized per UTC day, so a real tab-open pays this once.
 */
const BUDGET_MS = 320

describe('compose at the scale target', () => {
  let opened: ReturnType<typeof openDatabase>

  beforeAll(() => {
    // In-memory: what this test measures is compose()'s query latency over 100k
    // rows, which SQLite serves from its page cache — RAM whether the store is
    // `:memory:` or a disk file with a warm cache. A disk file only added the
    // WAL write cost of landing the 100k-row seed, which is what dragged the
    // beforeAll past 30s on a loaded Windows runner. In-memory removes that seed
    // cost and can only make the read budget below safer, never harder.
    opened = openDatabase(':memory:')
    const { db } = opened

    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', '/synthetic', 1).lastInsertRowid
    )

    const insertArtist = db.prepare('INSERT INTO artists (name) VALUES (?)')
    const artistIds = Array.from({ length: ARTISTS }, (_, index) =>
      Number(insertArtist.run(`Artist ${String(index).padStart(4, '0')}`).lastInsertRowid)
    )

    const insertAlbum = db.prepare(
      'INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)'
    )
    const albumIds = Array.from({ length: ALBUMS }, (_, index) =>
      Number(
        insertAlbum.run(
          `Album ${String(index).padStart(4, '0')}`,
          artistIds[index % ARTISTS],
          1970 + (index % 50)
        ).lastInsertRowid
      )
    )

    const insertTrack = db.prepare(
      `INSERT INTO tracks (
         root_id, rel_path, mtime, size, duration_ms, title, artist_id,
         album_id, track_no, disc_no, genre
       ) VALUES (?, ?, 1, 1, 200000, ?, ?, ?, ?, 1, ?)`
    )
    const insertGenre = db.prepare(
      // album_id denormalized (W12-8): this is the column genre-roulette's pool
      // gate now walks instead of correlating back to tracks.
      'INSERT INTO track_genres (track_id, genre_key, genre, album_id) VALUES (?, ?, ?, ?)'
    )
    const insertListen = db.prepare(
      `INSERT INTO listens
         (track_id, started_at, ms_listened, duration_ms, title, artist_name, album_title)
       VALUES (?, ?, 90000, 200000, ?, ?, ?)`
    )

    db.transaction(() => {
      for (let index = 0; index < TRACK_COUNT; index++) {
        const albumIndex = index % ALBUMS
        const artistIndex = albumIndex % ARTISTS
        const genre = `Genre ${index % GENRES}`
        const title = `Title ${String(index).padStart(6, '0')}`
        const result = insertTrack.run(
          rootId,
          `Artist ${String(artistIndex).padStart(4, '0')}/Album ${String(albumIndex).padStart(4, '0')}/${String(index).padStart(6, '0')}.flac`,
          title,
          artistIds[artistIndex],
          albumIds[albumIndex],
          (index % 18) + 1,
          genre
        )
        insertGenre.run(
          Number(result.lastInsertRowid),
          genre.toLowerCase(),
          genre,
          albumIds[albumIndex]
        )

        // A thin recent log so *for-you* and *artists* do real work rather
        // than taking the cold-start path this fixture would otherwise be.
        if (index < 800 && index % 4 === 0) {
          insertListen.run(
            Number(result.lastInsertRowid),
            NOW - (index % 20) * DAY_MS,
            title,
            `Artist ${String(artistIndex).padStart(4, '0')}`,
            `Album ${String(albumIndex).padStart(4, '0')}`
          )
        }
      }
    })()
  })

  afterAll(() => {
    opened.db.close()
  })

  it('returns shelves rather than an empty page', () => {
    const result = compose(opened.db, NOW)
    expect(result.dayKey).toBe('2024-06-15')
    expect(result.shelves.length).toBeGreaterThan(0)
    for (const shelf of result.shelves) {
      expect(shelf.items.length).toBeGreaterThan(0)
      expect(shelf.items.length).toBeLessThanOrEqual(10)
    }
  })

  it('answers inside the tab-open budget', () => {
    // 20 samples, as `relatedScale` and `listTracksScale` take. Nearest-rank
    // over five would land on `samples[4]` — the slowest of the five, not a p95
    // at all — so a single scheduling hiccup decided the run. Over twenty the
    // same expression picks the nineteenth, which is the statistic this claims
    // to be and which discards that one worst sample.
    for (let warm = 0; warm < 3; warm++) compose(opened.db, NOW)
    const samples: number[] = []
    for (let sample = 0; sample < 20; sample++) {
      const startedAt = performance.now()
      compose(opened.db, NOW)
      samples.push(performance.now() - startedAt)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
    expectWithinBudget(p95, BUDGET_MS, 'compose tab-open p95')
  })
})
