import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ARTIST_LINK_LIMIT, type ArtistLink } from '@shared/artistLinks'
import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { createCacheService, type CacheService } from '../../../src/main/cache/service'
import { openDatabase } from '../../../src/main/db'
import { migrate } from '../../../src/main/db/migrate'
import {
  createArtistLinksService,
  limitLinks,
  type ArtistLinksService
} from '../../../src/main/musicbrainz/urlRelationsService'
import type { NetClient, NetGetRequest } from '../../../src/main/net'

/**
 * Links, assembled. The two things worth asserting through the socket are the
 * same two the members service is: an unresolved artist never reaches the
 * network, and every network failure comes back as a state rather than a throw.
 * Here the first matters a shade more — these URLs open a browser, so answering
 * for the wrong artist is a link to the wrong front door.
 */

const NIRVANA = '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6'

let dir: string
let file: string
let requests: string[]

function stubClient(answer: unknown | NetFailure): NetClient {
  const failed =
    typeof answer === 'object' && answer !== null && 'kind' in answer && 'message' in answer

  return {
    getText: () => Promise.resolve(netFailed<string>({ kind: 'rejected', message: 'unused' })),
    postJson: () => Promise.resolve(netFailed<never>({ kind: 'rejected', message: 'unused' })),
    getBytes: () => Promise.resolve(netFailed<Uint8Array>({ kind: 'rejected', message: 'unused' })),
    getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      requests.push(request.url)
      return Promise.resolve(failed ? netFailed<T>(answer as NetFailure) : netOk(answer as T))
    }
  }
}

/** One `artists` row, resolved or not. No tracks: there is no library half here. */
function seedArtist(
  db: Database.Database,
  name: string,
  { mbid = null }: { mbid?: string | null } = {}
): number {
  return Number(
    db
      .prepare('INSERT INTO artists (name, mbid, mbid_source) VALUES (?, ?, ?)')
      .run(name, mbid, mbid === null ? null : 'auto').lastInsertRowid
  )
}

interface Harness {
  db: Database.Database
  service: ArtistLinksService
  cache: CacheService
  close(): void
}

function harness(answer: unknown | NetFailure): Harness {
  const { db } = openDatabase(file)
  const cacheDb = new Database(':memory:')
  migrate(cacheDb, CACHE_MIGRATIONS)
  const cache = createCacheService({ db: cacheDb })

  return {
    db,
    cache,
    service: createArtistLinksService({ db, client: stubClient(answer), cache }),
    close: () => {
      db.close()
      cacheDb.close()
    }
  }
}

/** A MusicBrainz artist document carrying one homepage. */
function document(resource = 'https://nirvana.com/'): unknown {
  return {
    id: NIRVANA,
    relations: [
      { type: 'official homepage', direction: 'forward', 'target-type': 'url', url: { resource } }
    ]
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-test-'))
  file = join(dir, 'library.db')
  requests = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('artist links service', () => {
  it('never asks about an artist it cannot identify', async () => {
    // No MBID means no lookup, which means no chance of opening the wrong
    // artist's homepage.
    const h = harness(document())
    const artistId = seedArtist(h.db, 'Nirvana')

    const result = await h.service.get(artistId)

    expect(result.status).toBe('none')
    expect(result.links).toEqual([])
    expect(requests).toEqual([])
    h.close()
  })

  it('answers an artist that has left the library with an empty state', async () => {
    const h = harness(document())

    const result = await h.service.get(9999)

    expect(result.status).toBe('none')
    expect(requests).toEqual([])
    h.close()
  })

  it('returns the links for a resolved artist', async () => {
    const h = harness(document())
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const result = await h.service.get(artistId)

    expect(result.status).toBe('ready')
    expect(result.links).toEqual([{ category: 'homepage', url: 'https://nirvana.com/' }])
    h.close()
  })

  it('fetches once and answers the second call from the cache', async () => {
    const h = harness(document())
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    await h.service.get(artistId)
    await h.service.get(artistId)

    expect(requests).toHaveLength(1)
    h.close()
  })

  it('reads a merged-away identifier as an empty state rather than a failure', async () => {
    const h = harness({ kind: 'not-found', message: 'The service has nothing for this.' })
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const result = await h.service.get(artistId)

    expect(result.status).toBe('none')
    expect(result.failure).toBeNull()
    h.close()
  })

  it('reports an unreachable service as a failure worth retrying', async () => {
    const h = harness({ kind: 'offline', message: 'No network connection.' })
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const result = await h.service.get(artistId)

    expect(result.status).toBe('unavailable')
    expect(result.failure?.kind).toBe('offline')
    h.close()
  })

  it('answers an artist MusicBrainz records no links for with an empty state', async () => {
    const h = harness({ id: NIRVANA, relations: [] })
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const result = await h.service.get(artistId)

    expect(result.status).toBe('none')
    expect(result.failure).toBeNull()
    h.close()
  })
})

describe('the cap', () => {
  it('answers an empty parse with none rather than an empty ready', () => {
    expect(limitLinks(1, [])).toMatchObject({ status: 'none', truncated: false })
  })

  it('caps the list and reports the truncation', () => {
    const links: ArtistLink[] = []
    for (let index = 0; index < ARTIST_LINK_LIMIT + 5; index++) {
      links.push({ category: 'social', url: `https://example.com/${index}` })
    }

    const result = limitLinks(1, links)

    expect(result.truncated).toBe(true)
    expect(result.links).toHaveLength(ARTIST_LINK_LIMIT)
  })
})
