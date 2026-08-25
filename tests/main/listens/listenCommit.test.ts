import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqlitePlayHistoryService } from '../../../src/main/history/service'
import { SqliteListenService } from '../../../src/main/listens/service'

/**
 * The listen commit — one transaction at departure (W10-4).
 *
 * Driven through the real migration list against a real SQLite file, like the
 * trail's tests and for the first of the same two reasons: the claims are about
 * what is durably in the database, and half of them are about constraints —
 * `NOT NULL`, the identity index, the `SET NULL` reference — that a fake would
 * simply not have.
 */

let dir: string
let file: string
let db: Database.Database

interface SeedTrack {
  title?: string | null
  artist?: string | null
  album?: string | null
  albumArtist?: string | null
  durationMs?: number | null
  genres?: readonly (readonly [key: string, display: string])[]
  override?: { title?: string; artist?: string; album?: string }
}

function artistId(name: string): number {
  const existing = db.prepare('SELECT id FROM artists WHERE name = ?').get(name) as
    { id: number } | undefined
  if (existing) return existing.id
  return Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
}

let nextPath = 0

/** One track under a single root, with whatever tags and overrides a test needs. */
function seedTrack(spec: SeedTrack = {}): number {
  const rootId =
    (db.prepare('SELECT id FROM roots LIMIT 1').get() as { id: number } | undefined)?.id ??
    Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Music', '/music', 0).lastInsertRowid
    )

  const albumId =
    spec.album === undefined || spec.album === null
      ? null
      : Number(
          db
            .prepare('INSERT INTO albums (title, album_artist_id) VALUES (?, ?)')
            .run(spec.album, spec.albumArtist ? artistId(spec.albumArtist) : null).lastInsertRowid
        )

  const trackId = Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id, duration_ms)
         VALUES (?, ?, 1, 2, ?, ?, ?, ?)`
      )
      .run(
        rootId,
        `t${nextPath++}.flac`,
        spec.title === undefined ? 'Tagged Title' : spec.title,
        spec.artist ? artistId(spec.artist) : null,
        albumId,
        spec.durationMs === undefined ? 200_000 : spec.durationMs
      ).lastInsertRowid
  )

  for (const [key, display] of spec.genres ?? []) {
    db.prepare('INSERT INTO track_genres (track_id, genre_key, genre) VALUES (?, ?, ?)').run(
      trackId,
      key,
      display
    )
  }

  if (spec.override) {
    db.prepare(
      `INSERT INTO track_overrides (track_id, title, artist_name, album_title, updated_at)
       VALUES (?, ?, ?, ?, 0)`
    ).run(
      trackId,
      spec.override.title ?? null,
      spec.override.artist ?? null,
      spec.override.album ?? null
    )
  }

  return trackId
}

interface ListenRow {
  id: number
  track_id: number | null
  started_at: number
  ms_listened: number
  duration_ms: number | null
  title: string
  artist_name: string | null
  album_title: string | null
  album_artist_name: string | null
}

function listens(): ListenRow[] {
  return db.prepare('SELECT * FROM listens ORDER BY id').all() as ListenRow[]
}

function genresOf(listenId: number): { genre_key: string; genre: string }[] {
  return db
    .prepare('SELECT genre_key, genre FROM listen_genres WHERE listen_id = ? ORDER BY genre_key')
    .all(listenId) as { genre_key: string; genre: string }[]
}

function trackCounters(trackId: number): { play_count: number; last_played_at: number | null } {
  return db.prepare('SELECT play_count, last_played_at FROM tracks WHERE id = ?').get(trackId) as {
    play_count: number
    last_played_at: number | null
  }
}

function service(): SqliteListenService {
  return new SqliteListenService({ db })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-listens-'))
  file = join(dir, 'library.db')
  db = openDatabase(file).db
  nextPath = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the listen commit', () => {
  it('writes one row carrying the reported ms_listened', async () => {
    const trackId = seedTrack({
      artist: 'Steve Reich',
      album: 'Music for 18',
      albumArtist: 'Reich'
    })
    const commit = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 97_531
    })

    expect(commit).toEqual({
      id: expect.any(Number),
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 97_531
    })
    expect(listens()).toEqual([
      {
        id: commit?.id,
        track_id: trackId,
        started_at: 1_700_000_000_000,
        ms_listened: 97_531,
        duration_ms: 200_000,
        title: 'Tagged Title',
        artist_name: 'Steve Reich',
        album_title: 'Music for 18',
        album_artist_name: 'Reich'
      }
    ])
  })

  it('snapshots the override rather than the tag (D7)', async () => {
    const trackId = seedTrack({
      title: 'Untitled Track 03',
      artist: 'Unknown Artist',
      album: 'Bootleg',
      override: { title: 'Pulse', artist: 'Steve Reich', album: 'Music for 18 Musicians' }
    })
    await service().record({ trackId, startedAt: 1_700_000_000_000, msListened: 120_000 })

    const [row] = listens()
    expect(row.title).toBe('Pulse')
    expect(row.artist_name).toBe('Steve Reich')
    expect(row.album_title).toBe('Music for 18 Musicians')
  })

  it('falls back to the tag for every field the override leaves null', async () => {
    const trackId = seedTrack({
      title: 'Tagged Title',
      artist: 'Tagged Artist',
      album: 'Tagged Album',
      override: { title: 'Corrected Title' }
    })
    await service().record({ trackId, startedAt: 1_700_000_000_000, msListened: 120_000 })

    const [row] = listens()
    expect(row.title).toBe('Corrected Title')
    expect(row.artist_name).toBe('Tagged Artist')
    expect(row.album_title).toBe('Tagged Album')
  })

  it('copies the track genres verbatim, key and display spelling both', async () => {
    const trackId = seedTrack({
      genres: [
        ['minimalism', 'Minimalism'],
        ['post-rock', 'Post-Rock']
      ]
    })
    const commit = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 120_000
    })

    expect(genresOf(commit!.id)).toEqual([
      { genre_key: 'minimalism', genre: 'Minimalism' },
      { genre_key: 'post-rock', genre: 'Post-Rock' }
    ])
  })

  it('commits a track with no genres, writing no listen_genres rows', async () => {
    const trackId = seedTrack({ genres: [] })
    const commit = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 120_000
    })

    expect(commit).not.toBeNull()
    expect(listens()).toHaveLength(1)
    expect(genresOf(commit!.id)).toEqual([])
  })

  it('increments play_count and sets last_played_at to started_at', async () => {
    const trackId = seedTrack()
    expect(trackCounters(trackId)).toEqual({ play_count: 0, last_played_at: null })

    await service().record({ trackId, startedAt: 1_700_000_000_000, msListened: 120_000 })
    expect(trackCounters(trackId)).toEqual({
      play_count: 1,
      last_played_at: 1_700_000_000_000
    })

    await service().record({ trackId, startedAt: 1_700_000_100_000, msListened: 120_000 })
    expect(trackCounters(trackId)).toEqual({
      play_count: 2,
      last_played_at: 1_700_000_100_000
    })
  })

  it('never moves last_played_at backwards, so it stays MAX(started_at)', async () => {
    // The quit flush is the case: a listen departed at shutdown can be committed
    // after one that started later. `last_played_at` is a cache of the log, and
    // a cache that can disagree with the table it caches is not one.
    const trackId = seedTrack()
    await service().record({ trackId, startedAt: 1_700_000_100_000, msListened: 120_000 })
    await service().record({ trackId, startedAt: 1_700_000_000_000, msListened: 120_000 })

    expect(trackCounters(trackId)).toEqual({ play_count: 2, last_played_at: 1_700_000_100_000 })
    const [maxima] = db
      .prepare('SELECT MAX(started_at) AS newest FROM listens WHERE track_id = ?')
      .all(trackId) as { newest: number }[]
    expect(trackCounters(trackId).last_played_at).toBe(maxima.newest)
  })

  it('writes nothing at all for a track that left the library', async () => {
    const trackId = seedTrack()
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)

    const commit = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 120_000
    })
    expect(commit).toBeNull()
    expect(listens()).toEqual([])
  })

  it('writes nothing for a track with no title to attribute the listen to', async () => {
    const trackId = seedTrack({ title: null, artist: 'Some Artist' })
    const commit = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 120_000
    })

    expect(commit).toBeNull()
    expect(listens()).toEqual([])
    // The point of the predicate: not a thrown NOT NULL constraint at the end
    // of an otherwise ordinary play.
    expect(trackCounters(trackId).play_count).toBe(0)
  })

  it('tolerates the identity index rather than throwing, and commits nothing twice', async () => {
    const trackId = seedTrack({ artist: 'Steve Reich' })
    const first = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 120_000
    })
    const second = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 180_000
    })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(listens()).toHaveLength(1)
    // Nothing at all happened the second time — the transaction is the unit.
    expect(trackCounters(trackId).play_count).toBe(1)
  })

  it('severs rather than cascades when the track is deleted (D17)', async () => {
    const trackId = seedTrack({ artist: 'Steve Reich', album: 'Music for 18' })
    const commit = await service().record({
      trackId,
      startedAt: 1_700_000_000_000,
      msListened: 120_000
    })
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)

    const [row] = listens()
    expect(row.id).toBe(commit?.id)
    expect(row.track_id).toBeNull()
    // Everything the row needs in order to still mean something is on the row.
    expect(row.title).toBe('Tagged Title')
    expect(row.artist_name).toBe('Steve Reich')
    expect(row.album_title).toBe('Music for 18')
    expect(row.ms_listened).toBe(120_000)
  })

  it('records repeat-one as one row per pass, distinguished by started_at', async () => {
    const trackId = seedTrack()
    const listenService = service()
    await listenService.record({ trackId, startedAt: 1_700_000_000_000, msListened: 200_000 })
    await listenService.record({ trackId, startedAt: 1_700_000_200_000, msListened: 200_000 })

    expect(listens().map((row) => row.started_at)).toEqual([1_700_000_000_000, 1_700_000_200_000])
    expect(trackCounters(trackId).play_count).toBe(2)
  })
})

describe('the trail and the log, side by side', () => {
  it('leaves a skipped track in play_history and out of listens', async () => {
    // What a skip looks like from main: the transport committed, so the trail
    // was told; the threshold was never crossed, so the log never was. The two
    // records answering different questions is the design.
    const skipped = seedTrack({ title: 'Skipped' })
    const listened = seedTrack({ title: 'Listened' })

    const history = new SqlitePlayHistoryService({ db })
    const listenService = service()

    await history.record(skipped)
    await history.record(listened)
    await listenService.record({
      trackId: listened,
      startedAt: 1_700_000_000_000,
      msListened: 180_000
    })

    const trail = await history.list({ limit: 10 })
    expect(trail.map((entry) => entry.track.title)).toEqual(['Listened', 'Skipped'])
    expect(listens().map((row) => row.title)).toEqual(['Listened'])
    expect(trackCounters(skipped).play_count).toBe(0)
  })
})

describe('the quit-time flush', () => {
  it('asks the renderer once and resolves on its answer', async () => {
    let asked = 0
    const listenService = new SqliteListenService({
      db,
      requestFlush: () => {
        asked += 1
      },
      flushTimeoutMs: 5_000
    })

    const flushed = listenService.flush()
    expect(asked).toBe(1)
    listenService.acknowledgeFlush()
    await expect(flushed).resolves.toBeUndefined()
  })

  it('joins a second caller to the first rather than asking twice', async () => {
    let asked = 0
    const listenService = new SqliteListenService({
      db,
      requestFlush: () => {
        asked += 1
      },
      flushTimeoutMs: 5_000
    })

    const first = listenService.flush()
    const second = listenService.flush()
    expect(asked).toBe(1)
    listenService.acknowledgeFlush()
    await Promise.all([first, second])
  })

  it('gives up on a renderer that never answers', async () => {
    const listenService = new SqliteListenService({
      db,
      requestFlush: () => {},
      flushTimeoutMs: 5
    })
    await expect(listenService.flush()).resolves.toBeUndefined()
  })

  it('resolves at once when there is nobody to ask', async () => {
    await expect(service().flush()).resolves.toBeUndefined()
  })

  it('is reusable — a second quit attempt asks again', async () => {
    let asked = 0
    const listenService = new SqliteListenService({
      db,
      requestFlush: () => {
        asked += 1
      },
      flushTimeoutMs: 5
    })

    await listenService.flush()
    await listenService.flush()
    expect(asked).toBe(2)
  })
})
