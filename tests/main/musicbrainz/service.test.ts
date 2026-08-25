import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { createCacheService, type CacheService } from '../../../src/main/cache/service'
import { openDatabase } from '../../../src/main/db'
import { migrate } from '../../../src/main/db/migrate'
import type { NetClient, NetGetRequest } from '../../../src/main/net'
import {
  createArtistIdentityService,
  type ArtistIdentityService
} from '../../../src/main/musicbrainz/service'
import { createArtistIdentityStore } from '../../../src/main/musicbrainz/store'
import {
  ABSENT,
  DAFT_PUNK,
  LED_ZEPPELIN,
  LED_ZEPPELIN_RELEASE_GROUPS,
  NIRVANA,
  type ReleaseGroupDocument,
  type SearchDocument
} from './fixtures'

/**
 * The half of R5 that is not arithmetic: what gets written down, what gets
 * asked for twice, and what the operator's choice is allowed to survive.
 *
 * A real library database on disk rather than an in-memory one, because two of
 * these assertions are about a *restart* — an operator correction surviving one
 * is a literal acceptance criterion, and it cannot be tested against a
 * connection that never closes.
 */

const ARTIST_NAME = 'Daft Punk'

let dir: string
let file: string
/** Everything the fake client was asked for, in order. */
let requests: string[]

interface Harness {
  service: ArtistIdentityService
  db: Database.Database
  cache: CacheService
  artistId: number
  trackId: number
  close(): void
}

/**
 * A `NetClient` that answers from a queue and records what it was asked.
 *
 * Never touches a socket, which is the point: `createNetClient`'s consent gate,
 * limiter and retries are W7-7's tests, and repeating them here would make this
 * file fail for reasons that have nothing to do with artist identity. What is
 * simulated instead is the *result* — including `declined`, which is how consent
 * being off reaches this layer.
 */
type Answer = SearchDocument | ReleaseGroupDocument | NetFailure

function stubClient(answers: Answer[]): NetClient {
  const queue = [...answers]
  return {
    getText: () => Promise.resolve(netFailed<string>({ kind: 'rejected', message: 'unused' })),
    // This service only ever reads; a post here would be a wiring mistake.
    postJson: () => Promise.resolve(netFailed<never>({ kind: 'rejected', message: 'unused' })),
    getBytes: () => Promise.resolve(netFailed<Uint8Array>({ kind: 'rejected', message: 'unused' })),
    getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      requests.push(request.url)
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(`unexpected request: ${request.url}`)
      }
      // Discriminated on the failure's own field rather than on each document's,
      // so a third document shape does not need a third branch here.
      return Promise.resolve('kind' in next ? netFailed<T>(next) : netOk(next as T))
    }
  }
}

/**
 * A library with one root, one artist and one track credited to it.
 *
 * `albums` is the corroboration signal: each title becomes an album the artist
 * fronts, with the track moved onto the first of them. Empty by default, which
 * is what keeps every test written before corroboration existed making the same
 * one request it always did.
 */
function seed(
  db: Database.Database,
  name: string,
  albums: readonly string[] = []
): { artistId: number; trackId: number } {
  const rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/srv/music', 1_700_000_000_000).lastInsertRowid
  )
  const artistId = Number(
    db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid
  )
  const albumIds = albums.map((title) =>
    Number(
      db.prepare('INSERT INTO albums (title, album_artist_id) VALUES (?, ?)').run(title, artistId)
        .lastInsertRowid
    )
  )
  const trackId = Number(
    db
      .prepare(
        'INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(rootId, 'a/one.flac', 1, 1, 'One', artistId, albumIds[0] ?? null).lastInsertRowid
  )
  return { artistId, trackId }
}

function harness(
  answers: Answer[],
  { name = ARTIST_NAME, albums = [] }: { name?: string; albums?: readonly string[] } = {}
): Harness {
  const { db } = openDatabase(file)
  const { artistId, trackId } = seed(db, name, albums)

  const cacheDb = new Database(':memory:')
  migrate(cacheDb, CACHE_MIGRATIONS)
  const cache = createCacheService({ db: cacheDb })

  return {
    service: createArtistIdentityService({ db, client: stubClient(answers), cache }),
    db,
    cache,
    artistId,
    trackId,
    close: () => {
      db.close()
      cacheDb.close()
    }
  }
}

/** Reopens the library the way a relaunch does, sharing the cache or not. */
function reopen(
  answers: Answer[],
  cache: CacheService
): { service: ArtistIdentityService; db: Database.Database } {
  const { db } = openDatabase(file)
  return {
    service: createArtistIdentityService({ db, client: stubClient(answers), cache }),
    db
  }
}

function mbidOf(
  db: Database.Database,
  artistId: number
): { mbid: string | null; source: string | null } {
  return db
    .prepare('SELECT mbid, mbid_source AS source FROM artists WHERE id = ?')
    .get(artistId) as { mbid: string | null; source: string | null }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-test-'))
  file = join(dir, 'library.db')
  requests = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('artist identity service', () => {
  it('promotes a confident match onto the artists row', async () => {
    const h = harness([DAFT_PUNK])
    try {
      const resolution = await h.service.resolve(h.trackId)

      expect(resolution?.status).toBe('resolved')
      expect(resolution?.source).toBe('auto')
      expect(resolution?.mbid).toBe('056e4f3e-d505-4dad-8ec1-d04f521cbb56')
      expect(mbidOf(h.db, h.artistId)).toEqual({
        mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
        source: 'auto'
      })
    } finally {
      h.close()
    }
  })

  /**
   * The card's second bullet, tested as behaviour rather than as schema: "a
   * match is made once per artist rather than once per play". One search, then
   * silence, however many times the deck asks.
   */
  it('makes the match once per artist and not once per play', async () => {
    const h = harness([DAFT_PUNK])
    try {
      await h.service.resolve(h.trackId)
      await h.service.resolve(h.trackId)
      await h.service.resolve(h.trackId)

      expect(requests).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  /**
   * And across a restart, with an empty cache — which is the case that proves
   * the column is doing the work rather than `cache.db`.
   */
  it('answers from the row after a restart with a cold cache', async () => {
    const h = harness([DAFT_PUNK])
    await h.service.resolve(h.trackId)
    h.close()

    const coldCacheDb = new Database(':memory:')
    migrate(coldCacheDb, CACHE_MIGRATIONS)
    requests = []

    const { service, db } = reopen([], createCacheService({ db: coldCacheDb }))
    try {
      const resolution = await service.resolve(1)
      expect(resolution?.status).toBe('resolved')
      expect(resolution?.mbid).toBe('056e4f3e-d505-4dad-8ec1-d04f521cbb56')
      expect(requests).toHaveLength(0)
    } finally {
      db.close()
      coldCacheDb.close()
    }
  })

  it('writes nothing when the name is ambiguous', async () => {
    const h = harness([NIRVANA], { name: 'Nirvana' })
    try {
      const resolution = await h.service.resolve(h.trackId)

      expect(resolution?.status).toBe('ambiguous')
      expect(resolution?.mbid).toBeNull()
      expect(resolution?.candidates).toHaveLength(3)
      expect(mbidOf(h.db, h.artistId)).toEqual({ mbid: null, source: null })
    } finally {
      h.close()
    }
  })

  /**
   * An unmatchable artist is queried once and then remembered as unmatchable —
   * the negative-caching rule, which is what stops a shuffle session turning one
   * bad tag into sustained one-per-second traffic.
   */
  it('asks once about an artist MusicBrainz has never heard of', async () => {
    const h = harness([ABSENT], { name: 'Zzyzx Tapedeck Quartet' })
    try {
      const first = await h.service.resolve(h.trackId)
      const second = await h.service.resolve(h.trackId)

      expect(first?.status).toBe('no-match')
      expect(second?.status).toBe('no-match')
      expect(requests).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  it('reports an unreachable service as a state, not an exception', async () => {
    const h = harness([{ kind: 'offline', message: 'Could not reach the service.' }])
    try {
      const resolution = await h.service.resolve(h.trackId)

      expect(resolution?.status).toBe('unavailable')
      expect(resolution?.failure?.kind).toBe('offline')
      expect(mbidOf(h.db, h.artistId)).toEqual({ mbid: null, source: null })
    } finally {
      h.close()
    }
  })

  /** D14's off switch, arriving here as an ordinary failure kind. */
  it('reports declined consent without pretending to have looked', async () => {
    const h = harness([{ kind: 'declined', message: 'Online lookups are off.' }])
    try {
      const resolution = await h.service.resolve(h.trackId)

      expect(resolution?.status).toBe('unavailable')
      expect(resolution?.failure?.kind).toBe('declined')
      expect(resolution?.candidates).toEqual([])
    } finally {
      h.close()
    }
  })

  it('answers with null for a track that has no artist credit', async () => {
    const h = harness([])
    try {
      h.db.prepare('UPDATE tracks SET artist_id = NULL WHERE id = ?').run(h.trackId)
      expect(await h.service.resolve(h.trackId)).toBeNull()
      expect(requests).toHaveLength(0)
    } finally {
      h.close()
    }
  })
})

describe('the operator’s correction', () => {
  const CHOSEN = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'

  it('is stored as manual and answered without a lookup', async () => {
    const h = harness([NIRVANA], { name: 'Nirvana' })
    try {
      await h.service.resolve(h.trackId)
      const chosen = await h.service.setMbid(h.artistId, CHOSEN)

      expect(chosen.status).toBe('resolved')
      expect(chosen.source).toBe('manual')
      expect(mbidOf(h.db, h.artistId)).toEqual({ mbid: CHOSEN, source: 'manual' })

      requests = []
      const again = await h.service.resolve(h.trackId)
      expect(again?.mbid).toBe(CHOSEN)
      expect(requests).toHaveLength(0)
    } finally {
      h.close()
    }
  })

  it('survives a restart', async () => {
    const h = harness([NIRVANA], { name: 'Nirvana' })
    await h.service.resolve(h.trackId)
    await h.service.setMbid(h.artistId, CHOSEN)
    const trackId = h.trackId
    h.close()

    const cacheDb = new Database(':memory:')
    migrate(cacheDb, CACHE_MIGRATIONS)
    requests = []
    const { service, db } = reopen([], createCacheService({ db: cacheDb }))
    try {
      const resolution = await service.resolve(trackId)
      expect(resolution?.mbid).toBe(CHOSEN)
      expect(resolution?.source).toBe('manual')
      expect(requests).toHaveLength(0)
    } finally {
      db.close()
      cacheDb.close()
    }
  })

  /**
   * "Never silently overwritten by a later automatic match", tested where it is
   * actually enforced. The guard is the `UPDATE`'s `WHERE` clause, so this drives
   * the store directly rather than arranging a race through the service — the
   * point being that no code path, present or future, can go around it.
   */
  it('cannot be overwritten by an automatic match', () => {
    const h = harness([])
    try {
      const store = createArtistIdentityStore(h.db)
      store.setManual(h.artistId, CHOSEN)

      expect(store.promote(h.artistId, '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6')).toBe(false)
      expect(mbidOf(h.db, h.artistId)).toEqual({ mbid: CHOSEN, source: 'manual' })
    } finally {
      h.close()
    }
  })

  it('holds even when the operator chose while a search was in flight', () => {
    const h = harness([])
    try {
      const store = createArtistIdentityStore(h.db)
      // An automatic match lands first, as it would on an untouched row.
      expect(store.promote(h.artistId, '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6')).toBe(true)
      // The operator disagrees.
      store.setManual(h.artistId, CHOSEN)
      // A second automatic match — a re-search after a rescan — must not land.
      expect(store.promote(h.artistId, '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6')).toBe(false)
      expect(mbidOf(h.db, h.artistId).mbid).toBe(CHOSEN)
    } finally {
      h.close()
    }
  })

  /**
   * "None of these" is a decision and not an absence: it is stored, it reports
   * as `no-match` with a manual source, and it stops the matcher asking again.
   */
  it('records "none of these" durably', async () => {
    const h = harness([NIRVANA], { name: 'Nirvana' })
    try {
      await h.service.resolve(h.trackId)
      const chosen = await h.service.setMbid(h.artistId, null)

      expect(chosen.status).toBe('no-match')
      expect(chosen.source).toBe('manual')
      expect(mbidOf(h.db, h.artistId)).toEqual({ mbid: null, source: 'manual' })

      requests = []
      await h.service.resolve(h.trackId)
      expect(requests).toHaveLength(0)
    } finally {
      h.close()
    }
  })

  it('is reversible, and matching resumes at once', async () => {
    const h = harness([DAFT_PUNK, DAFT_PUNK], { name: ARTIST_NAME })
    try {
      await h.service.setMbid(h.artistId, '5b11f4ce-a62d-471e-81fc-a69a8278c7da')
      const cleared = await h.service.clearMbid(h.artistId)

      expect(cleared.status).toBe('resolved')
      expect(cleared.source).toBe('auto')
      expect(cleared.mbid).toBe('056e4f3e-d505-4dad-8ec1-d04f521cbb56')
    } finally {
      h.close()
    }
  })

  /**
   * Opening the picker is not a second opinion. It fetches the list and leaves
   * the identity where it was — the deck must not change its mind underneath
   * somebody who opened it to disagree.
   */
  it('lists alternatives without adopting one', async () => {
    const h = harness([DAFT_PUNK, DAFT_PUNK])
    try {
      await h.service.setMbid(h.artistId, '5b11f4ce-a62d-471e-81fc-a69a8278c7da')
      const listed = await h.service.searchCandidates(h.artistId)

      expect(listed.candidates.map((c) => c.name)).toContain('Daft Punk')
      expect(listed.mbid).toBe('5b11f4ce-a62d-471e-81fc-a69a8278c7da')
      expect(listed.source).toBe('manual')
      expect(mbidOf(h.db, h.artistId).source).toBe('manual')
    } finally {
      h.close()
    }
  })

  /**
   * The corroboration path, end to end and against live-captured replies.
   *
   * This is the user-visible complaint that produced the third test: Led
   * Zeppelin, of all bands, arriving at the deck as "several artists go by this
   * name". Two requests settle it and the second only happens once, because the
   * MBID lands on the row.
   */
  describe('corroboration', () => {
    const ALBUMS = ['Led Zeppelin IV', 'Houses of the Holy']
    const LED_ZEPPELIN_MBID = '678d88b2-87b0-403b-b63d-5da7465aecc3'

    it('settles an ambiguous name against the albums in the library', async () => {
      const h = harness([LED_ZEPPELIN, LED_ZEPPELIN_RELEASE_GROUPS], {
        name: 'Led Zeppelin',
        albums: ALBUMS
      })
      try {
        const resolution = await h.service.resolve(h.trackId)

        expect(resolution?.status).toBe('resolved')
        expect(resolution?.mbid).toBe(LED_ZEPPELIN_MBID)
        // Written down, so the second request is never made again for this
        // artist however often the deck reopens.
        expect(mbidOf(h.db, h.artistId)).toEqual({ mbid: LED_ZEPPELIN_MBID, source: 'auto' })
        expect(requests).toHaveLength(2)
        expect(requests[1]).toContain('release-group')
      } finally {
        h.close()
      }
    })

    it('asks the second question only when the first one tied', async () => {
      // Daft Punk resolves on names alone. A second request here would be one
      // per artist per library rather than one per ambiguous artist, which is
      // the traffic pattern R5's secondary risk is about.
      const h = harness([DAFT_PUNK], { albums: ['Discovery'] })
      try {
        expect((await h.service.resolve(h.trackId))?.status).toBe('resolved')
        expect(requests).toHaveLength(1)
      } finally {
        h.close()
      }
    })

    it('does not ask when the library has no albums to ask about', async () => {
      // A release-group search with no title clause matches the artist's whole
      // discography, so there is nothing to learn and a request would be spent
      // learning it.
      const h = harness([NIRVANA], { name: 'Nirvana' })
      try {
        expect((await h.service.resolve(h.trackId))?.status).toBe('ambiguous')
        expect(requests).toHaveLength(1)
      } finally {
        h.close()
      }
    })

    it('stays ambiguous when MusicBrainz credits our albums to nobody', async () => {
      const h = harness([NIRVANA, { kind: 'not-found', message: 'nothing' }], {
        name: 'Nirvana',
        albums: ['A Bootleg Nobody Has']
      })
      try {
        const resolution = await h.service.resolve(h.trackId)
        expect(resolution?.status).toBe('ambiguous')
        // Still offered to the picker: unresolved is a first-class state.
        expect(resolution?.candidates.length).toBeGreaterThan(0)
        expect(mbidOf(h.db, h.artistId).mbid).toBeNull()
      } finally {
        h.close()
      }
    })

    it('stays ambiguous rather than failing when the second request cannot be made', async () => {
      // Consent switched off between the two requests, or the network dropped.
      // Either way the name verdict stands and nothing is written down.
      const h = harness([NIRVANA, { kind: 'offline', message: 'No network.' }], {
        name: 'Nirvana',
        albums: ['Nevermind']
      })
      try {
        const resolution = await h.service.resolve(h.trackId)
        expect(resolution?.status).toBe('ambiguous')
        expect(resolution?.failure).toBeNull()
      } finally {
        h.close()
      }
    })

    it('does not repeat either request across a restart', async () => {
      const h = harness([LED_ZEPPELIN, LED_ZEPPELIN_RELEASE_GROUPS], {
        name: 'Led Zeppelin',
        albums: ALBUMS
      })
      try {
        await h.service.resolve(h.trackId)
        requests = []

        // No answers queued at all: any request now throws.
        const again = reopen([], h.cache)
        try {
          const resolution = await again.service.resolve(h.trackId)
          expect(resolution?.mbid).toBe(LED_ZEPPELIN_MBID)
          expect(requests).toEqual([])
        } finally {
          again.db.close()
        }
      } finally {
        h.close()
      }
    })
  })
})
