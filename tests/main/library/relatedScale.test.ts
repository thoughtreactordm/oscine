import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'

/**
 * W7-5's first acceptance criterion, measured rather than asserted.
 *
 * The pane opens on a track change, so its whole result has to arrive inside a
 * frame or the deck stutters exactly when the operator is looking at it. Six
 * strands run per seed, and the one that can genuinely blow the budget is
 * genre: it is an equality over a low-cardinality column, so in a real library
 * "Rock" matches a fifth of everything.
 *
 * The fixture is built for that worst case on purpose. Five genres over 100,000
 * tracks means the genre strand's predicate matches 20,000 rows and has to
 * produce fifty albums from them — which is the query the composite
 * `(genre, album_id)` index from migration 10 exists for, and which a bare
 * `(genre)` index would answer by building a 20,000-row temporary b-tree every
 * time. If that index is ever dropped or reordered, this test is what notices.
 */

const TRACK_COUNT = 100_000
const ARTISTS = 2_000
const ALBUMS = 8_000
const GENRES = 5

/** One frame at 60 Hz, the same budget the browse queries are held to. */
const FRAME_MS = 16.7

describe('getRelated at the scale target', () => {
  let dir: string
  let opened: ReturnType<typeof openDatabase>
  let service: SqliteLibraryService
  let seedTrackId: number

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fermata-related-scale-'))
    opened = openDatabase(join(dir, 'library.db'))
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

    // Every album is credited to an artist and dated, so the discography and
    // year strands do real work rather than matching nothing.
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

    db.transaction(() => {
      for (let index = 0; index < TRACK_COUNT; index++) {
        const albumIndex = index % ALBUMS
        const artistIndex = albumIndex % ARTISTS
        // Laid out the way a real library is — `Artist/Album/track` — so the
        // folder strand's parent-directory range has something to range over.
        const relPath =
          `Artist ${String(artistIndex).padStart(4, '0')}/` +
          `Album ${String(albumIndex).padStart(4, '0')}/` +
          `${String(index).padStart(6, '0')}.flac`
        // Every twentieth track is credited to someone other than the album
        // artist, which is what makes the compilations strand non-empty.
        const guest = index % 20 === 0
        insertTrack.run(
          rootId,
          relPath,
          `Title ${String(index).padStart(6, '0')}`,
          artistIds[guest ? (artistIndex + 1) % ARTISTS : artistIndex],
          albumIds[albumIndex],
          (index % 18) + 1,
          `Genre ${index % GENRES}`
        )
      }
    })()

    seedTrackId = Number(
      (db.prepare('SELECT id FROM tracks LIMIT 1 OFFSET 50000').get() as { id: number }).id
    )

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

  it('exercises every strand against the fixture', async () => {
    // The budget below is only meaningful if the queries are actually finding
    // things — a fixture that accidentally matched nothing would be fast and
    // prove nothing.
    const result = await service.getRelated({ trackId: seedTrackId })
    expect(result).not.toBeNull()
    expect(result!.sections.map((section) => section.strand)).toEqual([
      'album-tracks',
      'artist-albums',
      'compilations',
      'genre',
      'year',
      'folder'
    ])
  })

  it('caps each strand rather than returning everything it matched', async () => {
    // 20,000 tracks share the seed's genre. Without the inner limit this
    // section would carry thousands of albums and the pane would be shipping
    // megabytes through a structured clone on every track change.
    const result = await service.getRelated({ trackId: seedTrackId })
    for (const section of result!.sections) {
      const rows = section.kind === 'tracks' ? section.tracks.length : section.albums.length
      expect(rows).toBeLessThanOrEqual(50)
    }
  })

  it('answers within one frame', async () => {
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

    const elapsed = await p95(() => service.getRelated({ trackId: seedTrackId }))
    expect(elapsed).toBeLessThan(FRAME_MS)
  })
})
