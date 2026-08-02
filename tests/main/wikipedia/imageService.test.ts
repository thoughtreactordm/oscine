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
import type { DerivedArtworkStore } from '../../../src/main/library/derivedArtwork'
import type { NetClient, NetGetRequest } from '../../../src/main/net'
import {
  createArtistImageService,
  type ArtistImageService
} from '../../../src/main/wikipedia/imageService'

/**
 * The three hops as a whole: which requests happen, what lands where, and which
 * of the several ways to have no photograph is an empty state rather than an
 * error.
 *
 * Two properties this file exists for above the others. The picture must end up
 * in the *artwork* cache and only its hash in `cache.db` — that is D14 and the
 * card's whole premise, and it is the kind of thing that stays true only if
 * something asserts it. And the hash `cache.db` holds has to be visible to the
 * artwork prune, or the first library reconcile after a lookup deletes the file
 * the row is still pointing at.
 */

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'
const ENTITY = 'Q11649'
const HASH = 'a'.repeat(64)

const SEARCH_HIT = { query: { search: [{ title: ENTITY }] } }
const SEARCH_MISS = { query: { search: [] } }
const SITELINKS = { entities: { [ENTITY]: { sitelinks: {} } } }

const CLAIM = {
  claims: {
    P18: [
      {
        rank: 'normal',
        mainsnak: { snaktype: 'value', datavalue: { value: 'Kurt Cobain 1992.jpg' } }
      }
    ]
  }
}
const NO_CLAIM = { claims: { P18: [] } }

const IMAGE_INFO = {
  query: {
    pages: [
      {
        imageinfo: [
          {
            mime: 'image/jpeg',
            thumburl: 'https://upload.wikimedia.org/thumb/640px-Kurt_Cobain_1992.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Kurt_Cobain_1992.jpg',
            extmetadata: {
              Artist: { value: 'P. Bergen' },
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
            }
          }
        ]
      }
    ]
  }
}

interface Route {
  match: string
  answer: unknown | NetFailure
}

let requests: string[]

function isFailure(answer: unknown): answer is NetFailure {
  return typeof answer === 'object' && answer !== null && 'kind' in answer && 'message' in answer
}

/**
 * A client that answers by matching the URL, not by position in a queue.
 *
 * The *order and count* of requests is half of what is under test here — a
 * warmed cache is supposed to make hops disappear — and a positional queue
 * would pass whether or not a hop was skipped. Anything unmatched throws.
 */
function stubClient(routes: Route[], bytes: Uint8Array | NetFailure = PICTURE): NetClient {
  return {
    getText: () => Promise.resolve(netFailed<string>({ kind: 'rejected', message: 'unused' })),
    getBytes(request: NetGetRequest): Promise<NetResult<Uint8Array>> {
      requests.push(request.url)
      return Promise.resolve(isFailure(bytes) ? netFailed<Uint8Array>(bytes) : netOk(bytes))
    },
    getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      requests.push(request.url)
      const route = routes.find((candidate) => request.url.includes(candidate.match))
      if (!route) throw new Error(`unexpected request: ${request.url}`)
      return Promise.resolve(
        isFailure(route.answer) ? netFailed<T>(route.answer) : netOk(route.answer as T)
      )
    }
  }
}

const PICTURE = new Uint8Array([1, 2, 3, 4])

/** The whole happy path, in the order the service walks it. */
const HAPPY: Route[] = [
  { match: 'list=search', answer: SEARCH_HIT },
  { match: 'wbgetentities', answer: SITELINKS },
  { match: 'wbgetclaims', answer: CLAIM },
  { match: 'commons.wikimedia.org', answer: IMAGE_INFO }
]

/**
 * The artwork cache, faked down to a set of hashes.
 *
 * Nothing here needs sharp: what the service does with the store is store bytes
 * and ask whether a hash is still on disk, and `held` is exactly enough to
 * answer both — including the case the real one has and a mock usually does
 * not, where the file went away between two lookups.
 */
function fakeArtwork(): DerivedArtworkStore & { held: Set<string>; stores: number } {
  const held = new Set<string>()
  return {
    held,
    stores: 0,
    store(bytes) {
      this.stores++
      // Undecodable bytes are `null`, the way the real store reports what sharp
      // refused. The empty array is the fixture for it.
      if (bytes.byteLength === 0) return Promise.resolve(null)
      held.add(HASH)
      return Promise.resolve({ hash: HASH, generated: true })
    },
    has: (hash) => Promise.resolve(held.has(hash))
  }
}

let dir: string
let file: string

interface Harness {
  service: ArtistImageService
  cache: CacheService
  artwork: ReturnType<typeof fakeArtwork>
  artistId: number
  close(): void
}

function seed(db: Database.Database, mbid: string | null): number {
  return Number(
    db
      .prepare('INSERT INTO artists (name, mbid, mbid_source) VALUES (?, ?, ?)')
      .run('Nirvana', mbid, mbid === null ? null : 'auto').lastInsertRowid
  )
}

function harness(
  routes: Route[],
  {
    mbid = MBID,
    cache,
    artwork = fakeArtwork(),
    bytes
  }: {
    mbid?: string | null
    cache?: CacheService
    artwork?: ReturnType<typeof fakeArtwork>
    bytes?: Uint8Array | NetFailure
  } = {}
): Harness {
  const { db } = openDatabase(file)
  const artistId = seed(db, mbid)

  const cacheDb = cache ? null : new Database(':memory:')
  if (cacheDb) migrate(cacheDb, CACHE_MIGRATIONS)
  const cacheService = cache ?? createCacheService({ db: cacheDb as Database.Database })

  return {
    service: createArtistImageService({
      db,
      client: stubClient(routes, bytes ?? PICTURE),
      cache: cacheService,
      artwork,
      locale: () => 'en-GB'
    }),
    cache: cacheService,
    artwork,
    artistId,
    close: () => {
      db.close()
      cacheDb?.close()
    }
  }
}

/**
 * Reopens the library the way a relaunch does, keeping the cache and artwork.
 *
 * Distinct from a second `harness` because the artist is already on disk: the
 * point of the test below is that the cache row survived while the file did
 * not, so re-seeding the row would be testing a fresh library instead.
 */
function reopen(
  routes: Route[],
  cache: CacheService,
  artwork: ReturnType<typeof fakeArtwork>
): Omit<Harness, 'artwork' | 'cache'> {
  const { db } = openDatabase(file)
  const artistId = Number(
    (db.prepare('SELECT id FROM artists WHERE name = ?').get('Nirvana') as { id: number }).id
  )

  return {
    service: createArtistImageService({
      db,
      client: stubClient(routes, PICTURE),
      cache,
      artwork,
      locale: () => 'en-GB'
    }),
    artistId,
    close: () => db.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-artist-image-'))
  file = join(dir, 'library.db')
  requests = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the artist photograph', () => {
  it('walks four requests and answers with artwork routes and a credit', async () => {
    const h = harness(HAPPY)
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('ready')
    expect(result.image?.entityId).toBe(ENTITY)
    expect(result.image?.file).toBe('Kurt Cobain 1992.jpg')
    expect(result.image?.large).toBe(`fermata://artwork/${HASH}/large`)
    expect(result.image?.small).toBe(`fermata://artwork/${HASH}/small`)
    expect(result.image?.credit.artist).toBe('P. Bergen')
    expect(result.image?.credit.licence).toBe('CC BY-SA 4.0')
  })

  /**
   * The card's premise, stated as an assertion. `cache.db` is a few hundred
   * bytes naming a hash; the picture is in the artwork cache. A payload that
   * grew to hold bytes would blow through the 1 MiB entry ceiling and quietly
   * stop being cached at all.
   */
  it('puts the bytes in the artwork cache and only the hash in cache.db', async () => {
    const h = harness(HAPPY)
    await h.service.get(h.artistId)

    expect(h.artwork.held.has(HASH)).toBe(true)
    const row = h.cache.read<{ hash: string }>('commons.image', ENTITY)
    expect(row?.value?.hash).toBe(HASH)
    expect(h.cache.stats().bytes).toBeLessThan(1024)
    h.close()
  })

  /** The half the artwork prune reads. Without it the next reconcile deletes the file. */
  it('reports the hash it is holding, for the artwork prune', async () => {
    const h = harness(HAPPY)
    expect(h.service.referencedHashes().size).toBe(0)
    await h.service.get(h.artistId)
    expect([...h.service.referencedHashes()]).toEqual([HASH])
    h.close()
  })

  it('asks nothing twice for a second look at the same artist', async () => {
    const h = harness(HAPPY)
    await h.service.get(h.artistId)
    const first = requests.length
    await h.service.get(h.artistId)
    h.close()

    expect(requests.length).toBe(first)
  })

  /**
   * The reason this shares `wikidata.entity` with the biography rather than
   * resolving the item itself: an artist whose prose has already loaded costs
   * two requests for a picture rather than four.
   */
  it('reuses the item the biography already resolved', async () => {
    const cacheDb = new Database(':memory:')
    migrate(cacheDb, CACHE_MIGRATIONS)
    const cache = createCacheService({ db: cacheDb })
    cache.writeValue('wikidata.entity', `${MBID}/en`, { entityId: ENTITY, sitelinks: [] })

    const h = harness(HAPPY, { cache })
    await h.service.get(h.artistId)
    h.close()
    cacheDb.close()

    expect(requests.some((url) => url.includes('list=search'))).toBe(false)
    expect(requests.some((url) => url.includes('wbgetclaims'))).toBe(true)
  })
})

describe('the several ways to have no photograph', () => {
  it('is none for an artist nobody has resolved, without a request', async () => {
    const h = harness(HAPPY, { mbid: null })
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('none')
    expect(requests).toEqual([])
  })

  it('is none for an artist with no wikidata item', async () => {
    const h = harness([{ match: 'list=search', answer: SEARCH_MISS }])
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('none')
    expect(result.failure).toBeNull()
  })

  it('is none for an item carrying no image claim', async () => {
    const h = harness([
      { match: 'list=search', answer: SEARCH_HIT },
      { match: 'wbgetentities', answer: SITELINKS },
      { match: 'wbgetclaims', answer: NO_CLAIM }
    ])
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('none')
    // Cached negatively, so an artist with no picture is one request a week
    // rather than one a play. That is R5's secondary risk in one assertion.
    expect(requests.filter((url) => url.includes('wbgetclaims')).length).toBe(1)
  })

  it('is none for a commons file that has since been deleted', async () => {
    const h = harness([
      ...HAPPY.slice(0, 3),
      { match: 'commons.wikimedia.org', answer: { query: { pages: [{ missing: true }] } } }
    ])
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('none')
  })

  /**
   * Bytes arrived and sharp refused them. `none`, and remembered — the whole
   * argument for reporting a decode failure as `not-found` is that the
   * alternative re-downloads an undecodable file on every play forever.
   */
  it('is none, and remembered, for bytes the processor cannot decode', async () => {
    const h = harness(HAPPY, { bytes: new Uint8Array(0) })
    expect((await h.service.get(h.artistId)).status).toBe('none')

    const downloads = requests.filter((url) => url.includes('upload.wikimedia.org')).length
    expect((await h.service.get(h.artistId)).status).toBe('none')
    h.close()

    expect(requests.filter((url) => url.includes('upload.wikimedia.org')).length).toBe(downloads)
  })
})

describe('failures that are not empty states', () => {
  it('is unavailable with the failure when wikidata cannot be reached', async () => {
    const h = harness([
      { match: 'list=search', answer: { kind: 'offline', message: 'no route' } as NetFailure }
    ])
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('unavailable')
    expect(result.failure?.kind).toBe('offline')
  })

  it('is unavailable when lookups are declined, exactly as the biography is', async () => {
    const h = harness([
      { match: 'list=search', answer: { kind: 'declined', message: 'lookups off' } as NetFailure }
    ])
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('unavailable')
    expect(result.failure?.kind).toBe('declined')
  })

  it('is unavailable when commons is down after the claim resolved', async () => {
    const h = harness([
      ...HAPPY.slice(0, 3),
      {
        match: 'commons.wikimedia.org',
        answer: { kind: 'unavailable', message: 'maintenance' } as NetFailure
      }
    ])
    const result = await h.service.get(h.artistId)
    h.close()

    expect(result.status).toBe('unavailable')
    expect(result.failure?.kind).toBe('unavailable')
  })
})

describe('when the row and the file disagree', () => {
  /**
   * `cache.db` and the artwork directory are separate stores with separate
   * lifetimes. A prune that ran between two lookups, or an operator who deleted
   * the thumbnail cache, leaves a row pointing at nothing — and rendering it
   * would show the artwork placeholder under a real photographer's name.
   */
  it('refetches a picture whose file has gone', async () => {
    const artwork = fakeArtwork()
    const cacheDb = new Database(':memory:')
    migrate(cacheDb, CACHE_MIGRATIONS)
    const cache = createCacheService({ db: cacheDb })

    const first = harness(HAPPY, { cache, artwork })
    await first.service.get(first.artistId)
    first.close()

    // The prune, or an operator clearing the directory.
    artwork.held.clear()
    const before = artwork.stores

    const second = reopen(HAPPY, cache, artwork)
    const result = await second.service.get(second.artistId)
    second.close()
    cacheDb.close()

    expect(result.status).toBe('ready')
    expect(artwork.stores).toBe(before + 1)
    expect(artwork.held.has(HASH)).toBe(true)
  })
})
