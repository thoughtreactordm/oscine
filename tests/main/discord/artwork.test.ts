/**
 * Presence's album-art resolver — **W20-5**.
 *
 * Wired through the real `NetClient` and a real cache so the seams under test are
 * the ones that ship: the two-hop MusicBrainz → Cover Art Archive resolution,
 * consent at the socket, and the two negative caches that stop a shuffle session
 * from re-asking about an album MusicBrainz cannot match or a release CAA has no
 * front for. A track carries no MBID, so the tags are all the resolver has to go
 * on — exactly the presence signal's shape.
 */

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { PresenceTrack } from '@shared/presence'
import { createPresenceArtworkResolver } from '../../../src/main/discord/artwork'
import { createCacheService, type CacheService } from '../../../src/main/cache/service'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { migrate } from '../../../src/main/db/migrate'
import { createNetClient } from '../../../src/main/net/client'
import { CONSENT_DENIED, CONSENT_GRANTED, type NetworkConsent } from '../../../src/main/net/consent'
import type { RateLimiter } from '../../../src/main/net/rateLimiter'
import { createScopeRegistry } from '../../../src/main/net/scopes'

const RG_MBID = '11111111-1111-1111-1111-111111111111'
const OTHER_MBID = '22222222-2222-2222-2222-222222222222'
const CAA_FULL = 'https://coverartarchive.org/release-group/rg/front.jpg'
const CAA_THUMB = 'https://coverartarchive.org/release-group/rg/front-500.jpg'

const TRACK: PresenceTrack = {
  title: 'The Chain',
  artist: 'Fleetwood Mac',
  album: 'Rumours',
  albumArtist: 'Fleetwood Mac',
  durationMs: 270_000
}

function mbReply(mbid: string): unknown {
  return {
    'release-groups': [
      { id: mbid, title: 'Rumours', score: 100, 'artist-credit': [{ name: 'Fleetwood Mac' }] }
    ]
  }
}

const CAA_MANIFEST = {
  images: [{ front: true, image: CAA_FULL, thumbnails: { '500': CAA_THUMB } }]
}

interface RouteOptions {
  /** The release-group MBID the MusicBrainz search returns, or `null` for no match. */
  mbid?: string | null
  /** Whether the Cover Art Archive has a front for it. */
  caaHasFront?: boolean
}

function routingFetch(options: RouteOptions = {}): {
  fetchImpl: typeof fetch
  calls: string[]
} {
  const { mbid = RG_MBID, caaHasFront = true } = options
  const calls: string[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('musicbrainz.org')) {
      const body = mbid === null ? { 'release-groups': [] } : mbReply(mbid)
      return Promise.resolve(new Response(JSON.stringify(body)))
    }
    if (url.includes('coverartarchive.org')) {
      return caaHasFront
        ? Promise.resolve(new Response(JSON.stringify(CAA_MANIFEST)))
        : Promise.resolve(new Response('not found', { status: 404 }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function passiveLimiter(): RateLimiter {
  return { acquire: () => Promise.resolve(), waiting: () => 0 }
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

function makeResolver(
  fetchImpl: typeof fetch,
  consent: NetworkConsent = CONSENT_GRANTED
): ReturnType<typeof createPresenceArtworkResolver> {
  const client = createNetClient({
    consent,
    limiter: passiveLimiter(),
    scopes: createScopeRegistry(),
    fetchImpl
  })
  return createPresenceArtworkResolver({ client, cache: makeCache() })
}

describe('presence artwork resolver', () => {
  it('resolves tags through MusicBrainz then the Cover Art Archive to a public URL', async () => {
    const { fetchImpl, calls } = routingFetch()
    const resolver = makeResolver(fetchImpl)

    // The bounded thumbnail, not the full image — Discord renders presence art small.
    expect(await resolver.resolve(TRACK)).toBe(CAA_THUMB)
    // Exactly the two hops: one MusicBrainz search, one CAA manifest.
    expect(calls.filter((u) => u.includes('musicbrainz.org'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('coverartarchive.org'))).toHaveLength(1)
  })

  it('returns null and opens no socket with online lookups off', async () => {
    const { fetchImpl, calls } = routingFetch()
    const resolver = makeResolver(fetchImpl, CONSENT_DENIED)

    expect(await resolver.resolve(TRACK)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('returns null and issues no request when the track has no album or artist', async () => {
    const { fetchImpl, calls } = routingFetch()
    const resolver = makeResolver(fetchImpl)

    expect(await resolver.resolve({ ...TRACK, album: null })).toBeNull()
    expect(await resolver.resolve({ ...TRACK, album: undefined })).toBeNull()
    expect(await resolver.resolve({ ...TRACK, artist: null, albumArtist: null })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('negative-caches an album MusicBrainz cannot match — no re-search on the next play', async () => {
    const { fetchImpl, calls } = routingFetch({ mbid: null })
    const resolver = makeResolver(fetchImpl)

    expect(await resolver.resolve(TRACK)).toBeNull()
    expect(await resolver.resolve(TRACK)).toBeNull()
    // One MusicBrainz search total, and the CAA is never reached without a match.
    expect(calls.filter((u) => u.includes('musicbrainz.org'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('coverartarchive.org'))).toHaveLength(0)
  })

  it('negative-caches a release with no CAA front — no re-request on the next play', async () => {
    const { fetchImpl, calls } = routingFetch({ caaHasFront: false })
    const resolver = makeResolver(fetchImpl)

    expect(await resolver.resolve(TRACK)).toBeNull()
    expect(await resolver.resolve(TRACK)).toBeNull()
    // Both hops asked exactly once; the second play is served from cache.
    expect(calls.filter((u) => u.includes('musicbrainz.org'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('coverartarchive.org'))).toHaveLength(1)
  })

  it('serves a resolved cover from cache on the next play, opening no socket', async () => {
    const { fetchImpl, calls } = routingFetch()
    const resolver = makeResolver(fetchImpl)

    expect(await resolver.resolve(TRACK)).toBe(CAA_THUMB)
    const afterFirst = calls.length
    expect(await resolver.resolve(TRACK)).toBe(CAA_THUMB)
    expect(calls).toHaveLength(afterFirst)
  })

  it('keys the cover cache on release identity, not the free-text tag', async () => {
    // Two different albums that MusicBrainz resolves to two different release
    // groups must not share a cover-cache entry: the cover is keyed on the MBID.
    let served = RG_MBID
    const calls: string[] = []
    const fetchImpl = ((input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('musicbrainz.org')) {
        return Promise.resolve(new Response(JSON.stringify(mbReply(served))))
      }
      // Each release group's manifest names its own thumbnail so the two are
      // distinguishable — the resolver returns the thumbnail.
      const thumb = url.includes(RG_MBID) ? `${CAA_THUMB}#a` : `${CAA_THUMB}#b`
      const manifest = { images: [{ front: true, image: CAA_FULL, thumbnails: { '500': thumb } }] }
      return Promise.resolve(new Response(JSON.stringify(manifest)))
    }) as unknown as typeof fetch

    const resolver = makeResolver(fetchImpl)
    served = RG_MBID
    const first = await resolver.resolve({ ...TRACK, album: 'Rumours' })
    served = OTHER_MBID
    const second = await resolver.resolve({ ...TRACK, album: 'Tusk' })

    expect(first).toBe(`${CAA_THUMB}#a`)
    expect(second).toBe(`${CAA_THUMB}#b`)
    // Each album drove its own CAA lookup, keyed on its own MBID.
    expect(calls.filter((u) => u.includes(RG_MBID))).toHaveLength(1)
    expect(calls.filter((u) => u.includes(OTHER_MBID))).toHaveLength(1)
  })
})
