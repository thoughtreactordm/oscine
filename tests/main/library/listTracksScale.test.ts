import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'
import type { ListTracksQuery } from '../../../src/shared/library'
import { expectWithinBudget } from '../../support/perfBudget'

const TRACK_COUNT = 100_000

describe('listTracks at the scale target', () => {
  let dir: string
  let opened: ReturnType<typeof openDatabase>
  let service: SqliteLibraryService

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-scale-'))
    opened = openDatabase(join(dir, 'library.db'))
    const { db } = opened

    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', '/synthetic', 1).lastInsertRowid
    )
    const insertArtist = db.prepare('INSERT INTO artists (name) VALUES (?)')
    const insertAlbum = db.prepare('INSERT INTO albums (title, album_artist_id) VALUES (?, ?)')
    const artistIds = Array.from({ length: 2_000 }, (_, index) =>
      Number(insertArtist.run(`Artist ${String(index).padStart(4, '0')}`).lastInsertRowid)
    )
    const albumIds = Array.from({ length: 8_000 }, (_, index) =>
      Number(insertAlbum.run(`Album ${String(index).padStart(4, '0')}`, null).lastInsertRowid)
    )
    const insertTrack = db.prepare(
      `INSERT INTO tracks (
         root_id, rel_path, mtime, size, duration_ms, title, artist_id,
         album_id, track_no, disc_no
       ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, 1)`
    )

    db.transaction(() => {
      for (let index = 0; index < TRACK_COUNT; index++) {
        const untagged = index % 50 === 0
        insertTrack.run(
          rootId,
          `${index}.flac`,
          45_000 + ((index * 7919) % 555_000),
          `Title ${String((index * 104729) % TRACK_COUNT).padStart(6, '0')}`,
          untagged ? null : artistIds[index % artistIds.length],
          untagged ? null : albumIds[index % albumIds.length],
          untagged ? null : (index % 18) + 1
        )
      }
    })()

    service = new SqliteLibraryService({
      db,
      pickFolder: async () => null,
      onProgress: () => {}
    })
  }, 15_000)

  afterAll(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a deep one-row page without a full-library sort', async () => {
    const medians: number[] = []

    for (const sort of ['trackNo', 'title', 'artist', 'album', 'durationSec'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const query: ListTracksQuery = {
          sort,
          direction,
          offset: 95_000,
          limit: 1
        }

        await service.listTracks(query) // Prepare statements and warm the page cache.
        const samples: number[] = []
        for (let sample = 0; sample < 5; sample++) {
          const startedAt = performance.now()
          const result = await service.listTracks(query)
          samples.push(performance.now() - startedAt)
          expect(result.tracks).toHaveLength(1)
          expect(result.total).toBe(TRACK_COUNT)
        }
        samples.sort((a, b) => a - b)
        medians.push(samples[2])
      }
    }

    // The pre-fix query takes 40–125 ms here because every column builds a
    // temporary 100k-row sort. The indexed path keeps the same deep lookup
    // inside this deliberately conservative 30 ms regression budget.
    expectWithinBudget(Math.max(...medians), 30, 'deep one-row page median')
  })

  it('keeps warm first-page browse, facet and true-infix search under one frame', async () => {
    async function p95(run: () => Promise<unknown>): Promise<number> {
      for (let warm = 0; warm < 3; warm++) await run()
      const samples: number[] = []
      for (let sample = 0; sample < 20; sample++) {
        const startedAt = performance.now()
        await run()
        samples.push(performance.now() - startedAt)
      }
      samples.sort((a, b) => a - b)
      return samples[Math.ceil(samples.length * 0.95) - 1]
    }

    const timings = {
      tracks: await p95(() =>
        service.listTracks({
          sort: 'title',
          direction: 'asc',
          offset: 0,
          limit: 100
        })
      ),
      artists: await p95(() => service.listArtists({ offset: 0, limit: 100 })),
      albums: await p95(() => service.listAlbums({ offset: 0, limit: 100 })),
      infixSearch: await p95(() =>
        service.listTracks({
          searchText: 'tle 0999',
          sort: 'title',
          direction: 'asc',
          offset: 0,
          limit: 100
        })
      )
    }

    console.info('100k warm first-page p95 ms', timings)
    for (const [label, elapsed] of Object.entries(timings))
      expectWithinBudget(elapsed, 16.7, `warm first-page ${label}`)
  })

  it('records indexed deep-window timings for the M3 exit gate', async () => {
    const measure = async (run: () => Promise<unknown>): Promise<number> => {
      await run()
      const startedAt = performance.now()
      await run()
      return performance.now() - startedAt
    }
    const timings = {
      artistFacet: await measure(() => service.listArtists({ offset: 1_900, limit: 100 })),
      albumFacet: await measure(() => service.listAlbums({ offset: 7_900, limit: 100 })),
      search: await measure(() =>
        service.listTracks({
          searchText: 'tle 09',
          sort: 'title',
          direction: 'asc',
          offset: 9_000,
          limit: 100
        })
      )
    }

    console.info('100k warm deep-window ms', timings)
    for (const [label, elapsed] of Object.entries(timings))
      expectWithinBudget(elapsed, 30, `deep-window ${label}`)
  })
})
