/**
 * The listen commit's other half — one `scrobble_queue` row per connected
 * target, in the same transaction (W11-5, D19).
 *
 * Against a real SQLite file through the real migration list, for the reason
 * `listenCommit.test.ts` gives: the claims here are about what is *durably* in
 * the database and about atomicity, and a fake has no transaction to roll back.
 *
 * The target is W11-1's stub rather than the Last.fm one. Nothing in this seam
 * is Last.fm-specific — it enqueues against `capabilities`, which is the whole
 * reason `capabilities` exists — and reaching for the real target would test
 * `submit` all over again on the way past.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqliteListenService } from '../../../src/main/listens/service'
import { ScrobbleOutbox } from '../../../src/main/scrobble/outbox'
import { createStubScrobbleTarget } from '../../../src/main/scrobble/stubTarget'
import type { ScrobbleTarget, ScrobbleTargetId } from '../../../src/shared/scrobble'

let dir: string
let db: Database.Database
let nextPath = 0

function artistId(name: string): number {
  const existing = db.prepare('SELECT id FROM artists WHERE name = ?').get(name) as
    { id: number } | undefined
  if (existing) return existing.id
  return Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
}

interface SeedTrack {
  title?: string | null
  artist?: string | null
  album?: string | null
  albumArtist?: string | null
  durationMs?: number | null
}

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

  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id, duration_ms)
         VALUES (?, ?, 1, 2, ?, ?, ?, ?)`
      )
      .run(
        rootId,
        `t${nextPath++}.flac`,
        spec.title === undefined ? 'Ascension Day' : spec.title,
        spec.artist === undefined
          ? artistId('Talk Talk')
          : spec.artist
            ? artistId(spec.artist)
            : null,
        albumId,
        spec.durationMs === undefined ? 366_000 : spec.durationMs
      ).lastInsertRowid
  )
}

interface QueueRow {
  id: number
  target: string
  kind: string
  listen_id: number | null
  track_id: number | null
  artist_name: string
  title: string
  album_title: string | null
  album_artist_name: string | null
  duration_s: number | null
  timestamp: number
}

const queue = (): QueueRow[] =>
  db.prepare('SELECT * FROM scrobble_queue ORDER BY id').all() as QueueRow[]

const listenCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM listens').get() as { n: number }).n

/** A service wired to the outbox, draining against whatever targets are given. */
function service(targets: readonly ScrobbleTarget[]): SqliteListenService {
  return new SqliteListenService({
    db,
    scrobble: { outbox: new ScrobbleOutbox(db), targets: () => targets }
  })
}

const connected = (id: ScrobbleTargetId = 'lastfm'): ReturnType<typeof createStubScrobbleTarget> =>
  createStubScrobbleTarget({ id, connected: true })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-listen-scrobble-'))
  db = openDatabase(join(dir, 'library.db')).db
  nextPath = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the listen commit enqueues', () => {
  it('writes one queue row per connected target, from the listen’s own snapshot', async () => {
    const trackId = seedTrack({ album: 'Laughing Stock', albumArtist: 'Talk Talk' })
    const commit = await service([connected()]).record({
      trackId,
      startedAt: 1_754_000_000_500,
      msListened: 200_000
    })

    expect(commit).not.toBeNull()
    const rows = queue()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      target: 'lastfm',
      kind: 'scrobble',
      listen_id: commit?.id,
      track_id: trackId,
      artist_name: 'Talk Talk',
      title: 'Ascension Day',
      album_title: 'Laughing Stock'
    })
  })

  it('stores the timestamp in seconds, not milliseconds', async () => {
    const trackId = seedTrack()
    await service([connected()]).record({
      trackId,
      // Deliberately not a round second: a truncation bug and a rounding bug
      // look identical against a value ending in 000.
      startedAt: 1_754_000_000_999,
      msListened: 200_000
    })

    // A millisecond value accepted as seconds dates the scrobble to the year
    // 56000, and the first place that shows up is somebody's public profile.
    expect(queue()[0].timestamp).toBe(1_754_000_000)
    expect(queue()[0].duration_s).toBe(366)
  })

  it('enqueues once per target when two are connected', async () => {
    const trackId = seedTrack()
    await service([connected('lastfm'), connected('listenbrainz')]).record({
      trackId,
      startedAt: 1_754_000_000_000,
      msListened: 200_000
    })

    expect(queue().map((row) => row.target)).toEqual(['lastfm', 'listenbrainz'])
  })

  it('skips a target that is not connected', async () => {
    const trackId = seedTrack()
    const offline = createStubScrobbleTarget({ id: 'listenbrainz', connected: false })
    await service([connected('lastfm'), offline]).record({
      trackId,
      startedAt: 1_754_000_000_000,
      msListened: 200_000
    })

    expect(queue().map((row) => row.target)).toEqual(['lastfm'])
  })

  it('writes the listen and no queue row when no account is connected', async () => {
    const trackId = seedTrack()
    const commit = await service([createStubScrobbleTarget({ connected: false })]).record({
      trackId,
      startedAt: 1_754_000_000_000,
      msListened: 200_000
    })

    // The overwhelmingly common case — somebody who has never signed in — and
    // the whole of W10 has to behave identically for them.
    expect(commit).not.toBeNull()
    expect(listenCount()).toBe(1)
    expect(queue()).toEqual([])
  })

  it('writes the listen and no queue row for a build with no scrobbling at all', async () => {
    const trackId = seedTrack()
    const commit = await new SqliteListenService({ db }).record({
      trackId,
      startedAt: 1_754_000_000_000,
      msListened: 200_000
    })

    expect(commit).not.toBeNull()
    expect(listenCount()).toBe(1)
    expect(queue()).toEqual([])
  })

  it('writes the listen and no queue row for a track with no artist', async () => {
    const trackId = seedTrack({ artist: null })
    const commit = await service([connected()]).record({
      trackId,
      startedAt: 1_754_000_000_000,
      msListened: 200_000
    })

    // The one written exception to Oscine's stats and the operator's profile
    // agreeing: every service rejects a submission with no artist, so the row
    // would never drain — while Oscine's own charts count the listen happily.
    expect(commit).not.toBeNull()
    expect(listenCount()).toBe(1)
    expect(queue()).toEqual([])
  })

  it('drops the listen too when the queue insert fails', async () => {
    const trackId = seedTrack()
    const listens = service([connected()])
    // A real failure of the enqueue statement rather than a stubbed throw: the
    // claim under test is that the two writes are one transaction, and the way
    // to test that is to break the second one for real.
    db.exec('DROP TABLE scrobble_queue')

    await expect(
      listens.record({ trackId, startedAt: 1_754_000_000_000, msListened: 200_000 })
    ).rejects.toThrow()

    // Neither row, and no half-applied side effects: a listen that recorded
    // without enqueueing is a scrobble silently lost, and the rollback is what
    // makes "same transaction" mean something.
    expect(listenCount()).toBe(0)
    expect(
      (
        db.prepare('SELECT play_count FROM tracks WHERE id = ?').get(trackId) as {
          play_count: number
        }
      ).play_count
    ).toBe(0)
  })

  it('enqueues nothing for a commit that wrote nothing', async () => {
    const trackId = seedTrack()
    const listens = service([connected()])
    const request = { trackId, startedAt: 1_754_000_000_000, msListened: 200_000 }

    await listens.record(request)
    // The identity index swallows the second one. It must not leave a queue row
    // behind either, or an offline afternoon of double-fired commits arrives at
    // Last.fm as a doubled history.
    expect(await listens.record(request)).toBeNull()
    expect(queue()).toHaveLength(1)
  })

  it('asks for the connected targets per commit, so signing in mid-session counts', async () => {
    const trackId = seedTrack()
    const target = createStubScrobbleTarget({ connected: false })
    const listens = new SqliteListenService({
      db,
      scrobble: { outbox: new ScrobbleOutbox(db), targets: () => [target] }
    })

    await listens.record({ trackId, startedAt: 1_754_000_000_000, msListened: 200_000 })
    expect(queue()).toEqual([])

    target.setConnected(true)
    await listens.record({ trackId, startedAt: 1_754_000_400_000, msListened: 200_000 })
    expect(queue()).toHaveLength(1)
  })
})

describe('the commit notification', () => {
  it('fires only for a commit that wrote a row', async () => {
    const trackId = seedTrack()
    let woken = 0
    const listens = new SqliteListenService({
      db,
      scrobble: { outbox: new ScrobbleOutbox(db), targets: () => [connected()] },
      onCommitted: () => {
        woken += 1
      }
    })
    const request = { trackId, startedAt: 1_754_000_000_000, msListened: 200_000 }

    await listens.record(request)
    expect(woken).toBe(1)

    // A duplicate the identity index swallowed enqueued nothing, so waking a
    // drain would be a request to Last.fm that nobody asked for.
    await listens.record(request)
    expect(woken).toBe(1)
  })
})
