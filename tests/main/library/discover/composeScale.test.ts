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

/** Tab-open budget. Four times a 60 Hz frame, generous for CI share. */
const BUDGET_MS = 250

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
      'INSERT INTO track_genres (track_id, genre_key, genre) VALUES (?, ?, ?)'
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
        insertGenre.run(Number(result.lastInsertRowid), genre.toLowerCase(), genre)

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
    const samples: number[] = []
    compose(opened.db, NOW)
    for (let sample = 0; sample < 5; sample++) {
      const startedAt = performance.now()
      compose(opened.db, NOW)
      samples.push(performance.now() - startedAt)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
    expectWithinBudget(p95, BUDGET_MS, 'compose tab-open p95')
  })
})
