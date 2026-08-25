/**
 * The loved push — one-way and forward-only (W11-6, D18, D19).
 *
 * Against a real SQLite file through the real migration list, as
 * `listenScrobbleEnqueue.test.ts` is and for its reason: the claims here are
 * about what is *durably* in the database and about atomicity, and a fake has no
 * transaction to roll back.
 *
 * The target is W11-1's stub rather than the Last.fm one. Nothing in this seam
 * is Last.fm-specific — it enqueues against `capabilities`, which is what
 * `capabilities` is for — and reaching for the real target would test `love` all
 * over again on the way past.
 *
 * Two of these tests assert an *absence*, and they are the ones the card is
 * mostly about. Nothing retroactive and nothing read back in are the boundaries
 * of the feature, and a boundary with no test is a boundary that moves.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqliteFavoriteService } from '../../../src/main/favorites/service'
import {
  createScrobbleDrainWorker,
  type ScrobbleDrainWorker
} from '../../../src/main/scrobble/drain'
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
}

function seedTrack(spec: SeedTrack = {}): number {
  const rootId =
    (db.prepare('SELECT id FROM roots LIMIT 1').get() as { id: number } | undefined)?.id ??
    Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Music', '/music', 0).lastInsertRowid
    )

  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, duration_ms)
         VALUES (?, ?, 1, 2, ?, ?, ?)`
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
        366_000
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
  duration_s: number | null
  timestamp: number
}

const queue = (): QueueRow[] =>
  db.prepare('SELECT * FROM scrobble_queue ORDER BY id').all() as QueueRow[]

const favoriteCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM track_favorites').get() as { n: number }).n

/** The heart wired to the outbox, against whatever targets and gate are given. */
function service(
  targets: readonly ScrobbleTarget[],
  lovePushEnabled = true
): SqliteFavoriteService {
  return new SqliteFavoriteService({
    db,
    scrobble: {
      outbox: new ScrobbleOutbox(db),
      targets: () => targets,
      lovePushEnabled: () => lovePushEnabled
    }
  })
}

const connected = (id: ScrobbleTargetId = 'lastfm'): ReturnType<typeof createStubScrobbleTarget> =>
  createStubScrobbleTarget({ id, connected: true })

function worker(targets: readonly ScrobbleTarget[]): ScrobbleDrainWorker {
  return createScrobbleDrainWorker({ outbox: new ScrobbleOutbox(db), targets: () => targets })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-favorite-love-'))
  db = openDatabase(join(dir, 'library.db')).db
  nextPath = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('hearting a track enqueues', () => {
  it('writes a love row per connected target, from the track’s own names', async () => {
    const trackId = seedTrack()
    const state = await service([connected()]).toggle(trackId)

    expect(state.favorite).toBe(true)
    const rows = queue()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      target: 'lastfm',
      kind: 'love',
      track_id: trackId,
      artist_name: 'Talk Talk',
      title: 'Ascension Day',
      // Provenance is the track, not a listen — nothing was played.
      listen_id: null,
      // `track.love` has no parameter for either, so neither is snapshotted.
      album_title: null,
      duration_s: null
    })
  })

  it('writes an unlove row when the heart comes off', async () => {
    const trackId = seedTrack()
    const favorites = service([connected()])
    await favorites.toggle(trackId)
    const state = await favorites.toggle(trackId)

    expect(state.favorite).toBe(false)
    expect(queue().map((row) => row.kind)).toEqual(['love', 'unlove'])
  })

  it('enqueues for every connected target that has loves', async () => {
    const trackId = seedTrack()
    await service([connected('lastfm'), connected('listenbrainz')]).toggle(trackId)

    expect(queue().map((row) => row.target)).toEqual(['lastfm', 'listenbrainz'])
  })

  it('resolves the names through track_overrides, as the rail draws them', async () => {
    const trackId = seedTrack()
    db.prepare(
      'INSERT INTO track_overrides (track_id, title, artist_name, updated_at) VALUES (?, ?, ?, ?)'
    ).run(trackId, 'Ascension Day (corrected)', 'Talk Talk!', Date.now())

    await service([connected()]).toggle(trackId)

    // A correction is the name the operator believes the song has, and it is the
    // one that should reach Last.fm — the same two columns the listen commit
    // resolves the same way, so a scrobble and a love can never disagree.
    expect(queue()[0]).toMatchObject({
      artist_name: 'Talk Talk!',
      title: 'Ascension Day (corrected)'
    })
  })

  it('stores the timestamp in seconds, not milliseconds', async () => {
    const trackId = seedTrack()
    await service([connected()]).toggle(trackId)

    const seconds = Math.floor(Date.now() / 1000)
    expect(queue()[0].timestamp).toBeGreaterThan(seconds - 5)
    expect(queue()[0].timestamp).toBeLessThanOrEqual(seconds + 1)
  })
})

describe('the ordering three flips depend on', () => {
  it('settles loved after heart, un-heart, heart', async () => {
    const trackId = seedTrack()
    const favorites = service([connected()])
    await favorites.toggle(trackId)
    await favorites.toggle(trackId)
    await favorites.toggle(trackId)

    expect(favoriteCount()).toBe(1)
    expect(queue().map((row) => row.kind)).toEqual(['love', 'unlove', 'love'])

    // Three flips in one second share a `timestamp`, so `id ASC` is the only
    // thing separating them — and arriving as un-heart last would leave the
    // operator's account in the state they did not ask for.
    const target = connected()
    await worker([target]).wake()

    expect(target.calls.loved).toHaveLength(2)
    expect(target.calls.unloved).toHaveLength(1)
    expect(queue()).toEqual([])
  })
})

describe('un-favoriting a batch', () => {
  it('enqueues one unlove per heart actually withdrawn', async () => {
    const first = seedTrack({ title: 'Ascension Day' })
    const second = seedTrack({ title: 'After The Flood' })
    const never = seedTrack({ title: 'Taphead' })
    const favorites = service([connected()])
    await favorites.toggle(first)
    await favorites.toggle(second)

    const result = await favorites.remove([first, second, never])

    expect(result).toEqual({ removed: 2 })
    const unloves = queue().filter((row) => row.kind === 'unlove')
    // Not three. An id that was not favorited was not un-hearted, so there is
    // nothing to withdraw.
    expect(unloves.map((row) => row.title).sort()).toEqual(['After The Flood', 'Ascension Day'])
  })

  it('sends nothing the second time, because nothing was withdrawn', async () => {
    const trackId = seedTrack()
    const favorites = service([connected()])
    await favorites.toggle(trackId)
    await favorites.remove([trackId])
    const before = queue().length

    await favorites.remove([trackId])

    expect(queue()).toHaveLength(before)
  })
})

describe('the three ways it enqueues nothing', () => {
  it('enqueues nothing with the setting off, and still favorites', async () => {
    const trackId = seedTrack()
    const state = await service([connected()], false).toggle(trackId)

    expect(state.favorite).toBe(true)
    expect(favoriteCount()).toBe(1)
    expect(queue()).toEqual([])
  })

  it('enqueues nothing with no account connected', async () => {
    const trackId = seedTrack()
    // The overwhelmingly common case: nobody has ever signed in, and the whole
    // of favorites must work identically for them.
    const state = await service([createStubScrobbleTarget({ connected: false })]).toggle(trackId)

    expect(state.favorite).toBe(true)
    expect(queue()).toEqual([])
  })

  it('enqueues nothing for a target with no loves to record', async () => {
    const trackId = seedTrack()
    // ListenBrainz, in W11-8. A love row queued for it could never drain, so the
    // check belongs before the write rather than in the worker that finds it.
    await service([
      createStubScrobbleTarget({
        id: 'listenbrainz',
        connected: true,
        capabilities: { supportsLove: false }
      })
    ]).toggle(trackId)

    expect(favoriteCount()).toBe(1)
    expect(queue()).toEqual([])
  })

  it('favorites a track with no artist and enqueues nothing for it', async () => {
    const trackId = seedTrack({ artist: null })
    const state = await service([connected()]).toggle(trackId)

    // The heart is a local fact and stands whether or not any service can be
    // told about it. Refusing the favorite over an untagged file would be the
    // library's problem punishing the operator's gesture.
    expect(state.favorite).toBe(true)
    expect(favoriteCount()).toBe(1)
    expect(queue()).toEqual([])
  })

  it('enqueues nothing for a track that is not in the library', async () => {
    const state = await service([connected()]).toggle(9_999)

    expect(state).toEqual({ trackId: 9_999, favorite: false, favoritedAt: null })
    expect(queue()).toEqual([])
  })
})

describe('forward-only', () => {
  it('pushes none of the favorites that already exist when an account arrives', async () => {
    // Five hundred hearts, made with nobody signed in.
    const offline = service([createStubScrobbleTarget({ connected: false })])
    const ids: number[] = []
    for (let index = 0; index < 500; index += 1) {
      const trackId = seedTrack({ title: `Track ${index}` })
      ids.push(trackId)
      await offline.toggle(trackId)
    }
    expect(favoriteCount()).toBe(500)
    expect(queue()).toEqual([])

    // Now an account connects. There is no code path that walks
    // `track_favorites` — a retroactive bulk push would be thousands of writes
    // to somebody else's account on the strength of one click.
    const target = connected()
    const online = service([target])
    await worker([target]).wake()

    expect(queue()).toEqual([])
    expect(target.calls.loved).toEqual([])

    // Only what happens next is pushed, which is the whole of "forward-only".
    await online.toggle(ids[0])
    expect(queue()).toHaveLength(1)
  })

  it('never reads a service’s loved tracks back in', () => {
    // D18: `track_favorites` is authoritative and local. There is no conflict
    // rule for "loved there, un-hearted here" and no right one to write, so the
    // contract has no method that could *return* a loved list — every verb on it
    // is a write outward. Pinning the whole surface rather than naming a method
    // that does not exist: adding a read-back breaks this test, which is where
    // the argument for it would then have to be made.
    const target = connected()
    const contract = Object.keys(target)
      .filter((key) => typeof (target as unknown as Record<string, unknown>)[key] === 'function')
      .filter((key) => !key.startsWith('queue') && key !== 'setConnected')
      .sort()

    expect(contract).toEqual([
      'authorize',
      'connection',
      'disconnect',
      'love',
      'nowPlaying',
      'submit',
      'unlove'
    ])
  })
})

describe('the snapshot outlives the track', () => {
  it('sends a love for a track that has since left the library', async () => {
    const trackId = seedTrack()
    await service([connected()]).toggle(trackId)

    // The rescan that removed it takes the favorite with it — `track_favorites`
    // cascades — but the queue row has no foreign key, deliberately (012). This
    // is exactly the case that motivated it: the network came back after a
    // rescan.
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)
    expect(favoriteCount()).toBe(0)
    expect(queue()).toHaveLength(1)

    const target = connected()
    await worker([target]).wake()

    expect(target.calls.loved).toEqual([{ artistName: 'Talk Talk', title: 'Ascension Day' }])
    expect(queue()).toEqual([])
  })
})

describe('the drain is woken', () => {
  it('tells the caller a gesture happened, so the love does not wait out the timer', async () => {
    const trackId = seedTrack()
    let wakes = 0
    const favorites = new SqliteFavoriteService({
      db,
      scrobble: {
        outbox: new ScrobbleOutbox(db),
        targets: () => [connected()],
        lovePushEnabled: () => true
      },
      onChanged: () => {
        wakes += 1
      }
    })

    await favorites.toggle(trackId)
    await favorites.remove([trackId])

    expect(wakes).toBe(2)
  })
})
