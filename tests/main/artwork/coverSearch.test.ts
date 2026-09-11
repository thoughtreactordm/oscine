/**
 * The edit-time album-art picker's main-process half — **W7-17**.
 *
 * Wired through the real `NetClient` and a real Cover Art Archive client so the
 * seams under test are the ones that ship: the two-hop MusicBrainz → CAA find,
 * the iTunes fallback, consent at the socket, the source allowlist on apply, and
 * — the property the card turns on — that a picked cover reaches the *same*
 * ingest a file pick does, byte-for-byte, so its override is identical.
 */

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ArtworkRef } from '@shared/artwork'
import { createCoverSearchService } from '../../../src/main/artwork/coverSearch'
import { createCoverArtArchiveClient } from '../../../src/main/artwork/coverArtArchive'
import { createCacheService, type CacheService } from '../../../src/main/cache/service'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { migrate } from '../../../src/main/db/migrate'
import { createNetClient } from '../../../src/main/net/client'
import { CONSENT_DENIED, CONSENT_GRANTED, type NetworkConsent } from '../../../src/main/net/consent'
import type { RateLimiter } from '../../../src/main/net/rateLimiter'
import { createScopeRegistry } from '../../../src/main/net/scopes'

const RG_MBID = '11111111-1111-1111-1111-111111111111'
const CAA_FULL = 'https://coverartarchive.org/release-group/rg/front.jpg'
const CAA_THUMB = 'https://coverartarchive.org/release-group/rg/front-500.jpg'
const ITUNES_600 = 'https://is1-ssl.mzstatic.com/image/thumb/Music/abc/600x600bb.jpg'

/** A minimal but real JPEG magic so `sniffImageMime` accepts the fetched bytes. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

const MB_REPLY = {
  'release-groups': [
    {
      id: RG_MBID,
      title: 'Rumours',
      score: 100,
      disambiguation: '2013 reissue',
      'artist-credit': [{ name: 'Fleetwood Mac', joinphrase: '' }]
    }
  ]
}

const CAA_MANIFEST = {
  images: [{ front: true, image: CAA_FULL, thumbnails: { '500': CAA_THUMB } }]
}

const ITUNES_REPLY = {
  results: [{ collectionName: 'Rumours', artistName: 'Fleetwood Mac', artworkUrl600: ITUNES_600 }]
}

function routingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('.jpg')) return Promise.resolve(new Response(JPEG_BYTES))
    if (url.includes('musicbrainz.org'))
      return Promise.resolve(new Response(JSON.stringify(MB_REPLY)))
    if (url.includes('coverartarchive.org')) {
      return Promise.resolve(new Response(JSON.stringify(CAA_MANIFEST)))
    }
    if (url.includes('itunes.apple.com')) {
      return Promise.resolve(new Response(JSON.stringify(ITUNES_REPLY)))
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

function makeService(
  fetchImpl: typeof fetch,
  consent: NetworkConsent = CONSENT_GRANTED
): {
  service: ReturnType<typeof createCoverSearchService>
  setCover: ReturnType<typeof vi.fn>
} {
  const client = createNetClient({
    consent,
    limiter: passiveLimiter(),
    scopes: createScopeRegistry(),
    fetchImpl
  })
  const coverArt = createCoverArtArchiveClient({ client, cache: makeCache() })
  const setCover = vi.fn(
    (_trackIds: readonly number[], _bytes: Uint8Array, mime: string): Promise<ArtworkRef> =>
      Promise.resolve({ present: true, hash: 'deadbeef', mime })
  )
  const service = createCoverSearchService({ client, coverArt, setCover })
  return { service, setCover }
}

describe('search', () => {
  it('resolves a MusicBrainz release group through the Cover Art Archive, then adds iTunes', async () => {
    const { fetchImpl } = routingFetch()
    const { service } = makeService(fetchImpl)
    const candidates = await service.search('Fleetwood Mac', 'Rumours')

    const caa = candidates.find((candidate) => candidate.source === 'coverartarchive')
    expect(caa).toEqual({
      source: 'coverartarchive',
      front: true,
      thumbUrl: CAA_THUMB,
      fullUrl: CAA_FULL,
      title: 'Rumours',
      detail: 'Fleetwood Mac'
    })

    const itunes = candidates.find((candidate) => candidate.source === 'itunes')
    expect(itunes?.fullUrl).toBe(ITUNES_600)
    expect(itunes?.title).toBe('Rumours')
  })

  it('is empty with online lookups off — both sources gated at the socket', async () => {
    const { fetchImpl, calls } = routingFetch()
    const { service } = makeService(fetchImpl, CONSENT_DENIED)
    expect(await service.search('Fleetwood Mac', 'Rumours')).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('applyRemoteCover', () => {
  it('fetches the picked bytes and hands them to the same ingest a file pick uses', async () => {
    const { fetchImpl } = routingFetch()
    const { service, setCover } = makeService(fetchImpl)

    const ref = await service.applyRemoteCover([7, 8], CAA_FULL)
    expect(ref).toEqual({ present: true, hash: 'deadbeef', mime: 'image/jpeg' })

    // The sink is `setArtworkFromBytes`, which hashes the bytes it is given, so
    // handing it exactly the fetched bytes is what makes a network pick identical
    // to a file pick of the same image — the card's identity-through-artworkHash.
    expect(setCover).toHaveBeenCalledTimes(1)
    const [trackIds, bytes, mime] = setCover.mock.calls[0]
    expect(trackIds).toEqual([7, 8])
    expect(mime).toBe('image/jpeg')
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(JPEG_BYTES))
  })

  it('refuses a URL off the source allowlist without fetching or storing', async () => {
    const { fetchImpl, calls } = routingFetch()
    const { service, setCover } = makeService(fetchImpl)

    await expect(service.applyRemoteCover([1], 'https://evil.test/cover.jpg')).rejects.toThrow(
      /allowed source/u
    )
    expect(calls).toHaveLength(0)
    expect(setCover).not.toHaveBeenCalled()
  })

  it('rejects a body that is not a real image before it reaches the store', async () => {
    // A manifest URL that serves HTML (a redirect/error page) rather than bytes.
    const fetchImpl = ((input: RequestInfo | URL) => {
      void input
      return Promise.resolve(new Response('<!doctype html>'))
    }) as unknown as typeof fetch
    const { service, setCover } = makeService(fetchImpl)

    await expect(service.applyRemoteCover([1], CAA_FULL)).rejects.toThrow(/JPEG or PNG/u)
    expect(setCover).not.toHaveBeenCalled()
  })
})
