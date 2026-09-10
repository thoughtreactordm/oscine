/**
 * The Cover Art Archive client — **W7-15**.
 *
 * Exercised through the real `NetClient` and a real in-memory cache rather than a
 * hand-rolled stub, because the properties under test are the seams: consent
 * checked at the socket, the per-host rate limiter, the body ceiling and the
 * negative cache. A stubbed client would assert the test's own idea of those
 * rules instead of the ones that ship.
 */

import Database from 'better-sqlite3'
import { describe, expect, it, afterEach } from 'vitest'

import {
  createCoverArtArchiveClient,
  fetchImageBytes,
  fetchReleaseFront,
  fetchReleaseGroupFront
} from '../../../src/main/artwork/coverArtArchive'
import { createCacheService, type CacheService } from '../../../src/main/cache/service'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { migrate } from '../../../src/main/db/migrate'
import { createNetClient } from '../../../src/main/net/client'
import { CONSENT_DENIED, CONSENT_GRANTED, type NetworkConsent } from '../../../src/main/net/consent'
import type { RateLimiter } from '../../../src/main/net/rateLimiter'
import { createScopeRegistry } from '../../../src/main/net/scopes'

const MBID = '76df3287-6cda-33eb-8e9a-044b5e15ffdd'
const RELEASE_URL = `https://coverartarchive.org/release/${MBID}`

/**
 * A recorded CAA payload: two images, back listed before front, each with the
 * full `thumbnails` map. Front-first ordering and the `500` thumbnail pick are
 * asserted against it.
 */
const MANIFEST = {
  images: [
    {
      front: false,
      image: 'https://coverartarchive.org/release/x/2.jpg',
      thumbnails: {
        '250': 'https://coverartarchive.org/release/x/2-250.jpg',
        '500': 'https://coverartarchive.org/release/x/2-500.jpg',
        '1200': 'https://coverartarchive.org/release/x/2-1200.jpg',
        small: 'https://coverartarchive.org/release/x/2-250.jpg',
        large: 'https://coverartarchive.org/release/x/2-500.jpg'
      }
    },
    {
      front: true,
      image: 'https://coverartarchive.org/release/x/1.jpg',
      thumbnails: {
        '250': 'https://coverartarchive.org/release/x/1-250.jpg',
        '500': 'https://coverartarchive.org/release/x/1-500.jpg',
        '1200': 'https://coverartarchive.org/release/x/1-1200.jpg',
        small: 'https://coverartarchive.org/release/x/1-250.jpg',
        large: 'https://coverartarchive.org/release/x/1-500.jpg'
      }
    }
  ]
}

interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A fake `fetch` that routes by URL and records every call and its init. */
function router(handler: (url: string) => Response): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(handler(String(input)))
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A limiter that records the hosts it was asked to acquire, in order. */
function recordingLimiter(): RateLimiter & { hosts: string[] } {
  const hosts: string[] = []
  return {
    hosts,
    acquire(host, signal) {
      hosts.push(host)
      if (signal?.aborted) return Promise.reject(signal.reason)
      return Promise.resolve()
    },
    waiting: () => 0
  }
}

function makeClient(
  fetchImpl: typeof fetch,
  {
    consent = CONSENT_GRANTED,
    limiter = recordingLimiter()
  }: {
    consent?: NetworkConsent
    limiter?: RateLimiter
  } = {}
): ReturnType<typeof createNetClient> {
  return createNetClient({ consent, limiter, scopes: createScopeRegistry(), fetchImpl })
}

const openCaches: CacheService[] = []
function makeCache(): CacheService {
  const db = new Database(':memory:')
  migrate(db, CACHE_MIGRATIONS)
  const cache = createCacheService({ db })
  openCaches.push(cache)
  return cache
}

afterEach(() => {
  while (openCaches.length > 0) openCaches.pop()?.close()
})

describe('fetchReleaseFront', () => {
  it('parses a manifest front-first, picking the 500px thumbnail', async () => {
    const { fetchImpl } = router(() => new Response(JSON.stringify(MANIFEST)))
    const result = await fetchReleaseFront(makeClient(fetchImpl), MBID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(2)

    const [front, back] = result.value
    // Front sorts ahead of the back cover the manifest listed first.
    expect(front).toEqual({
      source: 'coverartarchive',
      front: true,
      thumbUrl: 'https://coverartarchive.org/release/x/1-500.jpg',
      fullUrl: 'https://coverartarchive.org/release/x/1.jpg'
    })
    expect(back.front).toBe(false)
    expect(back.thumbUrl).toBe('https://coverartarchive.org/release/x/2-500.jpg')
  })

  it('drops an image that yields no usable URL', async () => {
    const { fetchImpl } = router(
      () => new Response(JSON.stringify({ images: [{ front: true }, MANIFEST.images[1]] }))
    )
    const result = await fetchReleaseFront(makeClient(fetchImpl), MBID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0].fullUrl).toBe('https://coverartarchive.org/release/x/1.jpg')
  })

  it('rejects a non-MBID without opening a socket', async () => {
    const { fetchImpl, calls } = router(() => new Response('{}'))
    const result = await fetchReleaseFront(makeClient(fetchImpl), 'not-an-mbid')
    expect(result).toMatchObject({ ok: false, failure: { kind: 'rejected' } })
    expect(calls).toHaveLength(0)
  })
})

describe('fetchReleaseGroupFront', () => {
  it('fetches the release-group endpoint', async () => {
    const { fetchImpl, calls } = router(() => new Response(JSON.stringify({ images: [] })))
    await fetchReleaseGroupFront(makeClient(fetchImpl), MBID)
    expect(calls[0].url).toBe(`https://coverartarchive.org/release-group/${MBID}`)
  })
})

describe('createCoverArtArchiveClient', () => {
  it('remembers a 404 negatively and hands back an empty list', async () => {
    const { fetchImpl, calls } = router(() => new Response('nope', { status: 404 }))
    const cache = makeCache()
    const caa = createCoverArtArchiveClient({ client: makeClient(fetchImpl), cache })

    const first = await caa.releaseFront(MBID)
    expect(first).toEqual({ ok: true, value: [] })
    expect(calls).toHaveLength(1)

    // The 404 is a negative cache row — a present record with a null value.
    expect(cache.read('coverartarchive.cover', `release:${MBID}`)).toEqual({
      value: null,
      fresh: true
    })

    // A second lookup answers from the cache without a second socket.
    const second = await caa.releaseFront(MBID)
    expect(second).toEqual({ ok: true, value: [] })
    expect(calls).toHaveLength(1)
  })

  it('caches a populated manifest and does not re-fetch it', async () => {
    const { fetchImpl, calls } = router(() => new Response(JSON.stringify(MANIFEST)))
    const cache = makeCache()
    const caa = createCoverArtArchiveClient({ client: makeClient(fetchImpl), cache })

    const first = await caa.releaseFront(MBID)
    const second = await caa.releaseFront(MBID)
    expect(first).toEqual(second)
    expect(first.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('opens no socket when consent is off and returns a usable result', async () => {
    const { fetchImpl, calls } = router(() => new Response(JSON.stringify(MANIFEST)))
    const client = makeClient(fetchImpl, { consent: CONSENT_DENIED })
    const caa = createCoverArtArchiveClient({ client, cache: makeCache() })

    const result = await caa.releaseFront(MBID)
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ ok: false, failure: { kind: 'declined' } })
  })
})

describe('fetchImageBytes', () => {
  it('refuses a body over the byte ceiling', async () => {
    const body = 'x'.repeat(64)
    const { fetchImpl } = router(
      () => new Response(body, { headers: { 'content-length': String(body.length) } })
    )
    const result = await fetchImageBytes(
      makeClient(fetchImpl),
      'https://coverartarchive.org/release/x/1.jpg',
      { maxBytes: 16 }
    )
    expect(result).toMatchObject({ ok: false, failure: { kind: 'malformed' } })
  })

  it('instructs fetch to follow the cross-host redirect', async () => {
    const { fetchImpl, calls } = router(() => new Response(new Uint8Array([1, 2, 3])))
    const result = await fetchImageBytes(
      makeClient(fetchImpl),
      'https://coverartarchive.org/release/x/1.jpg'
    )
    expect(result.ok).toBe(true)
    expect(calls[0].init?.redirect).toBe('follow')
  })

  it('keys the image fetch on its own host, not the manifest host', async () => {
    // The manifest is served from coverartarchive.org; the bytes live on
    // archive.org. Because the limiter keys on hostname, the two occupy separate
    // buckets and the image fetch is never serialised behind the manifest's clock.
    const { fetchImpl } = router((url) =>
      url === RELEASE_URL
        ? new Response(JSON.stringify(MANIFEST))
        : new Response(new Uint8Array([1, 2, 3]))
    )
    const limiter = recordingLimiter()
    const client = makeClient(fetchImpl, { limiter })

    await fetchReleaseFront(client, MBID)
    await fetchImageBytes(client, 'https://ia903000.us.archive.org/x/1.jpg')

    expect(limiter.hosts).toEqual(['coverartarchive.org', 'ia903000.us.archive.org'])
  })
})
