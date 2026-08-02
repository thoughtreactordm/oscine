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
  createArtistBiographyService,
  type ArtistBiographyService
} from '../../../src/main/wikipedia/service'

/**
 * The two hops as a whole: which requests happen, which do not happen twice,
 * and which of the several ways to have no biography is an empty state rather
 * than an error.
 *
 * The distinction the file mostly exists for is the last one. "Wikipedia has
 * never heard of this artist" and "we could not reach Wikipedia" look identical
 * from the pane unless this layer keeps them apart, and telling an operator the
 * first when the truth is the second sends them off to correct an identity that
 * was never wrong.
 */

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'

const SEARCH_HIT = { query: { search: [{ title: 'Q11649' }] } }
const SEARCH_MISS = { query: { search: [] } }

function sitelinks(sites: Record<string, { title: string; url: string }>): unknown {
  return {
    entities: {
      Q11649: {
        sitelinks: Object.fromEntries(
          Object.entries(sites).map(([site, link]) => [site, { site, ...link }])
        )
      }
    }
  }
}

const ENGLISH = sitelinks({
  enwiki: { title: 'Nirvana (band)', url: 'https://en.wikipedia.org/wiki/Nirvana_(band)' }
})

function extract(text: string, title = 'Nirvana (band)'): unknown {
  return { query: { pages: [{ title, extract: text }] } }
}

const MISSING_PAGE = { query: { pages: [{ missing: true, title: 'Nirvana (band)' }] } }

/**
 * A client that answers by matching the URL, not by position in a queue.
 *
 * Three different requests can be in play and the *order* is part of what is
 * under test — a positional queue would pass whether or not the service skipped
 * a hop. Anything unmatched throws, so an unexpected fourth request fails the
 * test that caused it rather than starving a later one.
 */
interface Route {
  match: string
  answer: unknown | NetFailure
}

let requests: string[]

function isFailure(answer: unknown): answer is NetFailure {
  return typeof answer === 'object' && answer !== null && 'kind' in answer && 'message' in answer
}

function stubClient(routes: Route[]): NetClient {
  return {
    getText: () => Promise.resolve(netFailed<string>({ kind: 'rejected', message: 'unused' })),
    getBytes: () => Promise.resolve(netFailed<Uint8Array>({ kind: 'rejected', message: 'unused' })),
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

let dir: string
let file: string

interface Harness {
  service: ArtistBiographyService
  cache: CacheService
  artistId: number
  close(): void
}

/** One artist, already resolved by W7-9 unless told otherwise. */
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
    locale = 'en-GB',
    cache
  }: { mbid?: string | null; locale?: string; cache?: CacheService } = {}
): Harness {
  const { db } = openDatabase(file)
  const artistId = seed(db, mbid)

  const cacheDb = cache ? null : new Database(':memory:')
  if (cacheDb) migrate(cacheDb, CACHE_MIGRATIONS)
  const cacheService = cache ?? createCacheService({ db: cacheDb as Database.Database })

  return {
    service: createArtistBiographyService({
      db,
      client: stubClient(routes),
      cache: cacheService,
      locale: () => locale
    }),
    cache: cacheService,
    artistId,
    close: () => {
      db.close()
      cacheDb?.close()
    }
  }
}

/**
 * Reopens the library the way a relaunch does, keeping the cache.
 *
 * Distinct from a second `harness` because the artist is already on disk: the
 * point of these two tests is that the *cache* survived, so re-seeding the row
 * would be testing a fresh library instead.
 */
function reopen(
  routes: Route[],
  cache: CacheService,
  locale = 'en-GB'
): { service: ArtistBiographyService; close(): void } {
  const { db } = openDatabase(file)
  return {
    service: createArtistBiographyService({
      db,
      client: stubClient(routes),
      cache,
      locale: () => locale
    }),
    close: () => db.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-test-'))
  file = join(dir, 'library.db')
  requests = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('artist biography service', () => {
  it('walks MBID to Wikidata to Wikipedia', async () => {
    const h = harness([
      { match: 'list=search', answer: SEARCH_HIT },
      { match: 'wbgetentities', answer: ENGLISH },
      { match: 'en.wikipedia.org', answer: extract('An American rock band from Aberdeen.') }
    ])
    try {
      const result = await h.service.get(h.artistId)

      expect(result.status).toBe('ready')
      expect(result.biography).toEqual({
        entityId: 'Q11649',
        title: 'Nirvana (band)',
        lang: 'en',
        url: 'https://en.wikipedia.org/wiki/Nirvana_(band)',
        extract: 'An American rock band from Aberdeen.'
      })
      expect(requests).toHaveLength(3)
    } finally {
      h.close()
    }
  })

  it('never asks when the artist has no MBID', async () => {
    // An unresolved artist is R5's first-class state. There is no identifier to
    // ask Wikidata about, so asking would be a request that cannot succeed.
    const h = harness([], { mbid: null })
    try {
      const result = await h.service.get(h.artistId)
      expect(result.status).toBe('none')
      expect(requests).toEqual([])
    } finally {
      h.close()
    }
  })

  it('is an empty state, not an error, when there is no Wikidata item', async () => {
    const h = harness([{ match: 'list=search', answer: SEARCH_MISS }])
    try {
      const result = await h.service.get(h.artistId)
      expect(result.status).toBe('none')
      expect(result.failure).toBeNull()
      // The second hop is not attempted: there is nothing to attempt it with.
      expect(requests).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  it('is an empty state when the item carries no article', async () => {
    const h = harness([
      { match: 'list=search', answer: SEARCH_HIT },
      { match: 'wbgetentities', answer: sitelinks({}) }
    ])
    try {
      const result = await h.service.get(h.artistId)
      expect(result.status).toBe('none')
      expect(requests).toHaveLength(2)
    } finally {
      h.close()
    }
  })

  it('is an empty state when the article has no extract', async () => {
    const h = harness([
      { match: 'list=search', answer: SEARCH_HIT },
      { match: 'wbgetentities', answer: ENGLISH },
      { match: 'en.wikipedia.org', answer: MISSING_PAGE }
    ])
    try {
      expect((await h.service.get(h.artistId)).status).toBe('none')
    } finally {
      h.close()
    }
  })

  it('reports a network failure as a failure rather than as no article', async () => {
    const offline: NetFailure = { kind: 'offline', message: 'No network.' }
    const h = harness([{ match: 'list=search', answer: offline }])
    try {
      const result = await h.service.get(h.artistId)
      expect(result.status).toBe('unavailable')
      expect(result.failure).toEqual(offline)
      expect(result.biography).toBeNull()
    } finally {
      h.close()
    }
  })

  it('reports declined lookups as unavailable, so consent is visibly off', async () => {
    // D14's gate reaches this layer as a `declined` from the client. Rendering
    // it as "no article" would make switching lookups off look like Wikipedia
    // having nothing on every artist in the library.
    const h = harness([
      { match: 'list=search', answer: { kind: 'declined', message: 'Online lookups are off.' } }
    ])
    try {
      const result = await h.service.get(h.artistId)
      expect(result.status).toBe('unavailable')
      expect(result.failure?.kind).toBe('declined')
    } finally {
      h.close()
    }
  })

  it('caches the negative case the card names', async () => {
    // An artist with an MBID and no Wikipedia article. Without this the lookup
    // repeats on every play, which over a shuffle session is the sustained
    // traffic R5's secondary risk is about.
    const routes: Route[] = [
      { match: 'list=search', answer: SEARCH_HIT },
      { match: 'wbgetentities', answer: ENGLISH },
      { match: 'en.wikipedia.org', answer: MISSING_PAGE }
    ]
    const first = harness(routes)
    try {
      expect((await first.service.get(first.artistId)).status).toBe('none')
      expect(requests).toHaveLength(3)

      requests = []
      const second = reopen(routes, first.cache)
      try {
        expect((await second.service.get(first.artistId)).status).toBe('none')
        expect(requests).toEqual([])
      } finally {
        second.close()
      }
    } finally {
      first.close()
    }
  })

  it('caches a found biography across a restart', async () => {
    const routes: Route[] = [
      { match: 'list=search', answer: SEARCH_HIT },
      { match: 'wbgetentities', answer: ENGLISH },
      { match: 'en.wikipedia.org', answer: extract('An American rock band.') }
    ]
    const first = harness(routes)
    try {
      await first.service.get(first.artistId)
      requests = []

      // No routes at all: a request of any kind now throws.
      const second = reopen([], first.cache)
      try {
        const result = await second.service.get(first.artistId)
        expect(result.status).toBe('ready')
        expect(result.biography?.extract).toBe('An American rock band.')
        expect(requests).toEqual([])
      } finally {
        second.close()
      }
    } finally {
      first.close()
    }
  })

  it('falls back to English when the operator’s language has no article', async () => {
    const h = harness(
      [
        { match: 'list=search', answer: SEARCH_HIT },
        {
          match: 'wbgetentities',
          answer: sitelinks({
            enwiki: { title: 'Nirvana (band)', url: 'https://en.wikipedia.org/wiki/Nirvana_(band)' }
          })
        },
        { match: 'en.wikipedia.org', answer: extract('An American rock band.') }
      ],
      { locale: 'de-DE' }
    )
    try {
      const result = await h.service.get(h.artistId)
      expect(result.biography?.lang).toBe('en')
      // Asked for both, got one — the request is filtered, not the fallback.
      expect(requests[1]).toContain('sitefilter=dewiki%7Cenwiki')
    } finally {
      h.close()
    }
  })

  it('prefers the operator’s language when both articles exist', async () => {
    const h = harness(
      [
        { match: 'list=search', answer: SEARCH_HIT },
        {
          match: 'wbgetentities',
          answer: sitelinks({
            dewiki: {
              title: 'Nirvana (Band)',
              url: 'https://de.wikipedia.org/wiki/Nirvana_(Band)'
            },
            enwiki: { title: 'Nirvana (band)', url: 'https://en.wikipedia.org/wiki/Nirvana_(band)' }
          })
        },
        { match: 'de.wikipedia.org', answer: extract('Eine US-Rockband.', 'Nirvana (Band)') }
      ],
      { locale: 'de-DE' }
    )
    try {
      const result = await h.service.get(h.artistId)
      expect(result.biography?.lang).toBe('de')
      expect(result.biography?.title).toBe('Nirvana (Band)')
      // English is never asked for: the first language answered.
      expect(requests.some((url) => url.includes('en.wikipedia.org'))).toBe(false)
    } finally {
      h.close()
    }
  })

  it('tries the next language when the first article has no extract', async () => {
    const h = harness(
      [
        { match: 'list=search', answer: SEARCH_HIT },
        {
          match: 'wbgetentities',
          answer: sitelinks({
            dewiki: {
              title: 'Nirvana (Band)',
              url: 'https://de.wikipedia.org/wiki/Nirvana_(Band)'
            },
            enwiki: { title: 'Nirvana (band)', url: 'https://en.wikipedia.org/wiki/Nirvana_(band)' }
          })
        },
        { match: 'de.wikipedia.org', answer: { query: { pages: [{ missing: true }] } } },
        { match: 'en.wikipedia.org', answer: extract('An American rock band.') }
      ],
      { locale: 'de-DE' }
    )
    try {
      expect((await h.service.get(h.artistId)).biography?.lang).toBe('en')
    } finally {
      h.close()
    }
  })

  it('stops rather than trying the next language when the network fails', async () => {
    // The second request would fail the same way. Trying it anyway is how one
    // unreachable host becomes two, and it would also report `unavailable` a
    // request later than it needed to.
    const h = harness(
      [
        { match: 'list=search', answer: SEARCH_HIT },
        {
          match: 'wbgetentities',
          answer: sitelinks({
            dewiki: {
              title: 'Nirvana (Band)',
              url: 'https://de.wikipedia.org/wiki/Nirvana_(Band)'
            },
            enwiki: { title: 'Nirvana (band)', url: 'https://en.wikipedia.org/wiki/Nirvana_(band)' }
          })
        },
        { match: 'de.wikipedia.org', answer: { kind: 'timeout', message: 'Timed out.' } }
      ],
      { locale: 'de-DE' }
    )
    try {
      const result = await h.service.get(h.artistId)
      expect(result.status).toBe('unavailable')
      expect(requests.some((url) => url.includes('en.wikipedia.org'))).toBe(false)
    } finally {
      h.close()
    }
  })

  it('shares one cached extract between two artists on the same article', async () => {
    const routes: Route[] = [
      { match: 'list=search', answer: SEARCH_HIT },
      { match: 'wbgetentities', answer: ENGLISH },
      { match: 'en.wikipedia.org', answer: extract('An American rock band.') }
    ]
    const first = harness(routes)
    try {
      await first.service.get(first.artistId)

      // A second artist, a different MBID, the same article — the solo career
      // and the band's own page, which is a real pattern in MusicBrainz.
      const { db } = openDatabase(file)
      try {
        const other = Number(
          db
            .prepare('INSERT INTO artists (name, mbid, mbid_source) VALUES (?, ?, ?)')
            .run('Kurt Cobain', '0ff17e5d-9034-4c0f-9c2d-cd4c86f39d1a', 'auto').lastInsertRowid
        )
        requests = []
        const service = createArtistBiographyService({
          db,
          client: stubClient(routes),
          cache: first.cache,
          locale: () => 'en'
        })

        expect((await service.get(other)).biography?.extract).toBe('An American rock band.')
        // Both Wikidata hops run — a different MBID is a different join — but
        // the article itself is already held.
        expect(requests.some((url) => url.includes('en.wikipedia.org'))).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      first.close()
    }
  })
})
