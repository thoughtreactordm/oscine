import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { createCacheService, type CacheService } from '../../../src/main/cache/service'
import { migrate } from '../../../src/main/db/migrate'
import { createNetClient, type NetClient, type NetGetRequest } from '../../../src/main/net/client'
import { createScopeRegistry } from '../../../src/main/net/scopes'
import { CONSENT_DENIED, CONSENT_GRANTED } from '../../../src/main/net/consent'
import type { RateLimiter } from '../../../src/main/net/rateLimiter'
import {
  createLyricsNetworkService,
  lyricsCacheKey
} from '../../../src/main/library/lyrics/network'
import type { LrclibQuery } from '../../../src/main/library/lyrics/lrclib'

const QUERY: LrclibQuery = {
  artist: 'Radiohead',
  title: 'Creep',
  album: 'Pablo Honey',
  durationSec: 238
}

const openDbs: Database.Database[] = []
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close()
})

function openCache(): CacheService {
  const db = new Database(':memory:')
  migrate(db, CACHE_MIGRATIONS)
  openDbs.push(db)
  return createCacheService({ db })
}

/** A `NetClient` answering `getJson` from a queue and recording every request. */
function queueClient(answers: Array<unknown | NetFailure>, seen: NetGetRequest[]): NetClient {
  const queue = [...answers]
  const unused = <T>(): Promise<NetResult<T>> =>
    Promise.resolve(netFailed<T>({ kind: 'rejected', message: 'unused' }))
  return {
    getText: () => unused<string>(),
    postJson: () => unused<never>(),
    getBytes: () => unused<Uint8Array>(),
    getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      seen.push(request)
      const next = queue.shift()
      if (next === undefined) throw new Error(`unexpected request: ${request.url}`)
      if (next !== null && typeof next === 'object' && 'kind' in (next as object)) {
        return Promise.resolve(netFailed<T>(next as NetFailure))
      }
      return Promise.resolve(netOk(next as T))
    }
  }
}

/** A limiter that never delays, so the lyrics path's own logic is what is measured. */
function openLimiter(): RateLimiter {
  return {
    acquire: (_host, signal) =>
      signal?.aborted ? Promise.reject(signal.reason) : Promise.resolve(),
    waiting: () => 0
  }
}

describe('lyricsCacheKey', () => {
  it('varies with duration so a re-tagged cut cannot reuse another version', () => {
    expect(lyricsCacheKey(QUERY)).not.toBe(lyricsCacheKey({ ...QUERY, durationSec: 200 }))
  })

  it('is stable under trivial casing and spacing differences', () => {
    expect(lyricsCacheKey(QUERY)).toBe(
      lyricsCacheKey({ ...QUERY, artist: '  RADIOHEAD ', title: 'creep' })
    )
  })
})

describe('createLyricsNetworkService', () => {
  it('caches a 404 negatively and does not re-request', async () => {
    const seen: NetGetRequest[] = []
    const service = createLyricsNetworkService({
      client: queueClient([{ kind: 'not-found', message: 'TrackNotFound' }], seen),
      cache: openCache()
    })

    expect(await service.fetch(QUERY)).toBeNull()
    // A second call for the same track is served from the negative entry — the
    // client is never asked again (an unexpected request would throw here).
    expect(await service.fetch(QUERY)).toBeNull()
    expect(seen).toHaveLength(1)
  })

  it('re-requests when only the duration differs', async () => {
    const seen: NetGetRequest[] = []
    const service = createLyricsNetworkService({
      client: queueClient(
        [
          { syncedLyrics: '[00:01.00]a', duration: 238 },
          { syncedLyrics: '[00:01.00]b', duration: 200 }
        ],
        seen
      ),
      cache: openCache()
    })

    await service.fetch(QUERY)
    await service.fetch({ ...QUERY, durationSec: 200 })
    expect(seen).toHaveLength(2)
  })

  it('returns instrumental as a document, not null', async () => {
    const service = createLyricsNetworkService({
      client: queueClient([{ instrumental: true, duration: 238 }], []),
      cache: openCache()
    })
    const doc = await service.fetch(QUERY)
    expect(doc?.instrumental).toBe(true)
  })

  it('does not fetch when artist or title is missing', async () => {
    const seen: NetGetRequest[] = []
    const service = createLyricsNetworkService({
      client: queueClient([], seen),
      cache: openCache()
    })
    expect(await service.fetch({ ...QUERY, artist: '' })).toBeNull()
    expect(await service.fetch({ ...QUERY, title: '   ' })).toBeNull()
    expect(seen).toHaveLength(0)
  })

  it('issues no request at all when consent is off', async () => {
    const fetchImpl = vi.fn()
    const client = createNetClient({
      consent: CONSENT_DENIED,
      limiter: openLimiter(),
      scopes: createScopeRegistry(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    const service = createLyricsNetworkService({ client, cache: openCache() })

    expect(await service.fetch(QUERY)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('abandons an in-flight request when the lyrics scope is cancelled', async () => {
    const scopes = createScopeRegistry()
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        })
    )
    const client = createNetClient({
      consent: CONSENT_GRANTED,
      limiter: openLimiter(),
      scopes,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1
    })
    const service = createLyricsNetworkService({ client, cache: openCache() })

    const pending = service.fetch(QUERY)
    // Let the request reach the socket before pulling the scope out from under it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    expect(scopes.cancel('lyrics')).toBe(1)
    expect(await pending).toBeNull()
  })
})
