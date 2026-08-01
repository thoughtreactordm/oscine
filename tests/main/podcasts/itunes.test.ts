import { describe, expect, it } from 'vitest'
import {
  catalogHitFromResult,
  createItunesClient,
  normalizeCatalogFeedUrl,
  parseChartEntries,
  parseSearchResults,
  usefulGenreIds
} from '../../../src/main/podcasts/itunes'

const SERIAL_RESULT = {
  kind: 'podcast',
  collectionId: 917918570,
  trackId: 917918570,
  artistName: 'Serial Productions',
  collectionName: 'Serial',
  feedUrl: 'https://feeds.simplecast.com/PpzWFGhg',
  artworkUrl600: 'https://is1-ssl.mzstatic.com/image/thumb/example.jpg/600x600bb.jpg',
  primaryGenreName: 'News',
  genreIds: ['1489', '26', '1488'],
  genres: ['News', 'Podcasts', 'True Crime']
}

describe('itunes catalogue parsers', () => {
  it('maps a search result and drops the Podcasts root genre', () => {
    const hit = catalogHitFromResult(SERIAL_RESULT)
    expect(hit).toMatchObject({
      collectionId: 917918570,
      title: 'Serial',
      author: 'Serial Productions',
      feedUrl: 'https://feeds.simplecast.com/PpzWFGhg',
      primaryGenreName: 'News'
    })
    expect(hit?.genreIds).toEqual(['1489', '1488'])
    expect(hit?.genres).toEqual(['News', 'True Crime'])
    expect(usefulGenreIds(hit!)).toEqual(['1489', '1488'])
  })

  it('rejects results without a usable feedUrl', () => {
    expect(catalogHitFromResult({ ...SERIAL_RESULT, feedUrl: undefined })).toBeNull()
    expect(catalogHitFromResult({ ...SERIAL_RESULT, feedUrl: 'ftp://example/feed' })).toBeNull()
  })

  it('parses search JSON and chart RSS JSON', () => {
    expect(parseSearchResults({ resultCount: 1, results: [SERIAL_RESULT] })).toHaveLength(1)
    expect(
      parseChartEntries({
        feed: {
          entry: [
            {
              'im:name': { label: 'Serial' },
              id: { attributes: { 'im:id': '917918570' } }
            }
          ]
        }
      })
    ).toEqual([{ collectionId: 917918570, title: 'Serial' }])
  })

  it('normalises feed URLs for subscription matching', () => {
    expect(normalizeCatalogFeedUrl('https://Example.com/feed/')).toBe('https://example.com/feed')
  })

  it('search and lookup go through the injected fetch', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/search?')) {
        return new Response(JSON.stringify({ resultCount: 1, results: [SERIAL_RESULT] }))
      }
      if (url.includes('/lookup?')) {
        return new Response(JSON.stringify({ resultCount: 1, results: [SERIAL_RESULT] }))
      }
      if (url.includes('/rss/')) {
        return new Response(
          JSON.stringify({
            feed: {
              entry: [
                {
                  'im:name': { label: 'Serial' },
                  id: { attributes: { 'im:id': '917918570' } }
                }
              ]
            }
          })
        )
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof fetch

    const client = createItunesClient({ fetchImpl, country: 'us' })
    expect(await client.search('serial', 5)).toHaveLength(1)
    expect(await client.lookupIds([917918570])).toHaveLength(1)
    expect(await client.chart('1488', 5)).toEqual([{ collectionId: 917918570, title: 'Serial' }])
    expect(calls.some((u) => u.includes('term=serial'))).toBe(true)
    expect(calls.some((u) => u.includes('id=917918570'))).toBe(true)
    expect(calls.some((u) => u.includes('genre=1488'))).toBe(true)
  })

  it('charts come from the toppodcasts generator, not the audio-only one', async () => {
    // Not pedantry about a URL: `topaudiopodcasts` answers 200 with an empty
    // feed for most genres, so picking the wrong generator fails as silently
    // empty categories rather than as an error anyone would notice.
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ feed: { entry: [] } }))
    }) as unknown as typeof fetch

    await createItunesClient({ fetchImpl, country: 'us' }).chart('1488', 5)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/rss/toppodcasts/')
    expect(calls[0]).not.toContain('topaudiopodcasts')
  })
})
