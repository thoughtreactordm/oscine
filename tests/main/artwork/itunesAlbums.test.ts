/**
 * iTunes album covers as picker candidates — **W7-17**'s fallback source.
 *
 * Exercised through the real `NetClient` so the seam under test is the one that
 * ships: the request rides the `cover-art` scope, and consent is checked at the
 * socket. The parse and the `artworkUrl100` upscale are unit-tested directly.
 */

import { describe, expect, it } from 'vitest'

import {
  parseItunesAlbumSearch,
  resizeItunesArtwork,
  searchItunesAlbumCovers
} from '../../../src/main/artwork/itunesAlbums'
import { createNetClient } from '../../../src/main/net/client'
import { CONSENT_DENIED, CONSENT_GRANTED, type NetworkConsent } from '../../../src/main/net/consent'
import type { RateLimiter } from '../../../src/main/net/rateLimiter'
import { createScopeRegistry } from '../../../src/main/net/scopes'

interface FetchCall {
  readonly url: string
}

function router(handler: (url: string) => Response): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    calls.push({ url: String(input) })
    return Promise.resolve(handler(String(input)))
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function passiveLimiter(): RateLimiter {
  return {
    acquire: () => Promise.resolve(),
    waiting: () => 0
  }
}

function makeClient(
  fetchImpl: typeof fetch,
  consent: NetworkConsent = CONSENT_GRANTED
): ReturnType<typeof createNetClient> {
  return createNetClient({
    consent,
    limiter: passiveLimiter(),
    scopes: createScopeRegistry(),
    fetchImpl
  })
}

const ART_100 = 'https://is1-ssl.mzstatic.com/image/thumb/Music/abc/100x100bb.jpg'
const ART_600 = 'https://is1-ssl.mzstatic.com/image/thumb/Music/abc/600x600bb.jpg'

describe('resizeItunesArtwork', () => {
  it('swaps only the square-size path segment', () => {
    expect(resizeItunesArtwork(ART_100, 600)).toBe(ART_600)
    expect(resizeItunesArtwork(ART_600, 300)).toBe(
      'https://is1-ssl.mzstatic.com/image/thumb/Music/abc/300x300bb.jpg'
    )
  })

  it('leaves a URL it does not recognise unchanged', () => {
    const other = 'https://example.test/cover.jpg'
    expect(resizeItunesArtwork(other, 600)).toBe(other)
  })
})

describe('parseItunesAlbumSearch', () => {
  it('builds a front candidate from the 600px artwork', () => {
    const candidates = parseItunesAlbumSearch({
      results: [
        {
          collectionName: 'Rumours',
          artistName: 'Fleetwood Mac',
          artworkUrl100: ART_100,
          artworkUrl600: ART_600
        }
      ]
    })
    expect(candidates).toEqual([
      {
        source: 'itunes',
        front: true,
        thumbUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music/abc/300x300bb.jpg',
        fullUrl: ART_600,
        title: 'Rumours',
        detail: 'Fleetwood Mac',
        width: 600,
        height: 600
      }
    ])
  })

  it('upscales artworkUrl100 when there is no 600px address', () => {
    const [candidate] = parseItunesAlbumSearch({
      results: [{ collectionName: 'X', artistName: 'Y', artworkUrl100: ART_100 }]
    })
    expect(candidate.fullUrl).toBe(ART_600)
    expect(candidate.thumbUrl).toBe(
      'https://is1-ssl.mzstatic.com/image/thumb/Music/abc/300x300bb.jpg'
    )
  })

  it('drops a result that names no artwork', () => {
    expect(parseItunesAlbumSearch({ results: [{ collectionName: 'X' }] })).toEqual([])
  })

  it('is empty for a malformed body', () => {
    expect(parseItunesAlbumSearch(null)).toEqual([])
    expect(parseItunesAlbumSearch({})).toEqual([])
  })
})

describe('searchItunesAlbumCovers', () => {
  const BODY = JSON.stringify({
    results: [{ collectionName: 'Rumours', artistName: 'Fleetwood Mac', artworkUrl600: ART_600 }]
  })

  it('queries Apple for albums and returns candidates', async () => {
    const { fetchImpl, calls } = router(() => new Response(BODY))
    const result = await searchItunesAlbumCovers(makeClient(fetchImpl), 'Fleetwood Mac', 'Rumours')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0].source).toBe('itunes')

    const requested = new URL(calls[0].url)
    expect(requested.hostname).toBe('itunes.apple.com')
    expect(requested.searchParams.get('entity')).toBe('album')
    expect(requested.searchParams.get('media')).toBe('music')
    expect(requested.searchParams.get('term')).toBe('Fleetwood Mac Rumours')
  })

  it('returns an empty list with online lookups off, opening no socket', async () => {
    const { fetchImpl, calls } = router(() => new Response(BODY))
    const result = await searchItunesAlbumCovers(
      makeClient(fetchImpl, CONSENT_DENIED),
      'Fleetwood Mac',
      'Rumours'
    )
    expect(result).toEqual({ ok: true, value: [] })
    expect(calls).toHaveLength(0)
  })

  it('returns an empty list for an all-empty search rather than a socket', async () => {
    const { fetchImpl, calls } = router(() => new Response(BODY))
    const result = await searchItunesAlbumCovers(makeClient(fetchImpl), '  ', '  ')
    expect(result).toEqual({ ok: true, value: [] })
    expect(calls).toHaveLength(0)
  })
})
