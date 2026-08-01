import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import type { ItunesClient } from '../../../src/main/podcasts/itunes'
import { SqlitePodcastService } from '../../../src/main/podcasts/service'
import type { PodcastCatalogHit } from '../../../src/shared/podcasts'

const FEED = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Pod</title>
    <itunes:author>Tester</itunes:author>
    <item>
      <title>Hello</title>
      <guid>g1</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example/hello.mp3" length="4" type="audio/mpeg" />
    </item>
  </channel>
</rss>`

let dir: string
let dbPath: string
let podcastsRoot: string
let artworkDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-podcasts-'))
  dbPath = join(dir, 'library.db')
  podcastsRoot = join(dir, 'podcasts')
  artworkDir = join(dir, 'artwork')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service(fetchImpl: typeof fetch, itunes?: ItunesClient) {
  const { db } = openDatabase(dbPath)
  return {
    db,
    podcasts: new SqlitePodcastService({
      db,
      podcastsRoot,
      artworkCacheDir: artworkDir,
      fetchImpl,
      itunes,
      artworkProcessor: {
        generate: async () => true,
        validate: async () => true,
        close: async () => undefined
      }
    })
  }
}

const CATALOG_HIT: PodcastCatalogHit = {
  collectionId: 1001,
  feedUrl: 'https://cdn.example/other.xml',
  title: 'Other Show',
  author: 'Someone',
  artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/x.jpg/100x100bb.jpg',
  primaryGenreName: 'True Crime',
  genres: ['True Crime', 'Podcasts'],
  genreIds: ['1488']
}

describe('SqlitePodcastService', () => {
  it('subscribes, lists episodes, and downloads an enclosure', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('feed.xml')) {
        return new Response(FEED, { status: 200 })
      }
      if (url.includes('hello.mp3')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-length': '4' }
        })
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof fetch

    const { db, podcasts } = service(fetchImpl)
    try {
      const podcast = await podcasts.subscribe('https://example.com/feed.xml')
      expect(podcast.title).toBe('Test Pod')
      expect(podcast.author).toBe('Tester')

      const listed = await podcasts.listPodcasts()
      expect(listed).toHaveLength(1)

      const episodes = await podcasts.listEpisodes({
        podcastId: podcast.id,
        offset: 0,
        limit: 20
      })
      expect(episodes.total).toBe(1)
      expect(episodes.episodes[0]?.title).toBe('Hello')
      expect(episodes.episodes[0]?.downloadStatus).toBe('remote')

      const downloaded = await podcasts.downloadEpisode(episodes.episodes[0]!.id)
      expect(downloaded.downloadStatus).toBe('ready')

      const abs = await podcasts.resolveEpisodePath(downloaded.id)
      expect(abs).not.toBeNull()
      expect((await stat(abs!)).size).toBe(4)
      expect(await readFile(abs!)).toEqual(Buffer.from([1, 2, 3, 4]))

      const recent = await podcasts.listRecent({ offset: 0, limit: 10 })
      expect(recent.episodes[0]?.podcastTitle).toBe('Test Pod')

      const removed = await podcasts.deleteDownload(downloaded.id)
      expect(removed.downloadStatus).toBe('remote')
      await expect(stat(abs!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      db.close()
    }
  })

  it('removes download files when unsubscribing', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('feed.xml')) return new Response(FEED, { status: 200 })
      if (url.includes('hello.mp3')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof fetch

    const { db, podcasts } = service(fetchImpl)
    try {
      const podcast = await podcasts.subscribe('https://example.com/feed.xml')
      const episodes = await podcasts.listEpisodes({
        podcastId: podcast.id,
        offset: 0,
        limit: 20
      })
      const downloaded = await podcasts.downloadEpisode(episodes.episodes[0]!.id)
      const abs = await podcasts.resolveEpisodePath(downloaded.id)
      expect(abs).not.toBeNull()

      await podcasts.unsubscribe(podcast.id)
      expect(await podcasts.listPodcasts()).toEqual([])
      await expect(stat(abs!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      db.close()
    }
  })

  it('rejects a duplicate subscription', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(FEED, { status: 200 })
    ) as unknown as typeof fetch
    const { db, podcasts } = service(fetchImpl)
    try {
      await podcasts.subscribe('https://example.com/feed.xml')
      await expect(podcasts.subscribe('https://example.com/feed.xml')).rejects.toMatchObject({
        code: 'conflict'
      })
    } finally {
      db.close()
    }
  })

  it('searches the injected Apple catalogue', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(FEED, { status: 200 })
    ) as unknown as typeof fetch
    const itunes: ItunesClient = {
      search: vi.fn(async () => [CATALOG_HIT]),
      lookupIds: vi.fn(async () => []),
      chart: vi.fn(async () => [])
    }
    const { db, podcasts } = service(fetchImpl, itunes)
    try {
      expect(await podcasts.searchCatalog('a')).toEqual({ hits: [] })
      const result = await podcasts.searchCatalog('other')
      expect(result.hits).toEqual([CATALOG_HIT])
      expect(itunes.search).toHaveBeenCalledWith('other', 25)
    } finally {
      db.close()
    }
  })

  it('recommends chart neighbours from subscription genres', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(FEED, { status: 200 })
    ) as unknown as typeof fetch
    const subHit: PodcastCatalogHit = {
      collectionId: 42,
      feedUrl: 'https://example.com/feed.xml',
      title: 'Test Pod',
      author: 'Tester',
      artworkUrl: null,
      primaryGenreName: 'True Crime',
      genres: ['True Crime', 'Podcasts'],
      genreIds: ['1488']
    }
    const itunes: ItunesClient = {
      search: vi.fn(async () => [subHit]),
      chart: vi.fn(async () => [
        { collectionId: 1001, title: 'Other Show' },
        { collectionId: 42, title: 'Test Pod' }
      ]),
      lookupIds: vi.fn(async () => [CATALOG_HIT, subHit])
    }
    const { db, podcasts } = service(fetchImpl, itunes)
    try {
      await podcasts.subscribe('https://example.com/feed.xml')
      const result = await podcasts.recommend()
      expect(result.coldStart).toBe(false)
      expect(result.shelves).toHaveLength(1)
      expect(result.shelves[0]?.id).toBe('1488')
      expect(result.shelves[0]?.kind).toBe('genre')
      expect(result.shelves[0]?.title).toBe('True Crime')
      expect(result.shelves[0]?.reason).toContain('1 show')
      expect(result.shelves[0]?.hits.map((h) => h.collectionId)).toEqual([1001])
      expect(itunes.chart).toHaveBeenCalledWith('1488', 25)
    } finally {
      db.close()
    }
  })

  it('falls back to popular charts when nothing is subscribed', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(FEED, { status: 200 })
    ) as unknown as typeof fetch
    const itunes: ItunesClient = {
      search: vi.fn(async () => []),
      chart: vi.fn(async () => [{ collectionId: 1001, title: 'Other Show' }]),
      lookupIds: vi.fn(async () => [CATALOG_HIT])
    }
    const { db, podcasts } = service(fetchImpl, itunes)
    try {
      const result = await podcasts.recommend()
      expect(result.coldStart).toBe(true)
      expect(result.shelves.length).toBeGreaterThan(0)
      expect(result.shelves.every((shelf) => shelf.kind === 'popular')).toBe(true)
      // Nothing to learn from, so no per-subscription enrichment happened.
      expect(itunes.search).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('serves repeat recommend calls from cache until a subscription changes', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(FEED, { status: 200 })
    ) as unknown as typeof fetch
    const itunes: ItunesClient = {
      search: vi.fn(async () => []),
      chart: vi.fn(async () => [{ collectionId: 1001, title: 'Other Show' }]),
      lookupIds: vi.fn(async () => [CATALOG_HIT])
    }
    const { db, podcasts } = service(fetchImpl, itunes)
    try {
      await podcasts.recommend()
      const afterFirst = (itunes.chart as ReturnType<typeof vi.fn>).mock.calls.length
      await podcasts.recommend()
      expect((itunes.chart as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterFirst)

      await podcasts.subscribe('https://example.com/feed.xml')
      await podcasts.recommend()
      expect((itunes.chart as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        afterFirst
      )
    } finally {
      db.close()
    }
  })

  it('browses one category and drops shows already subscribed', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(FEED, { status: 200 })
    ) as unknown as typeof fetch
    const subHit: PodcastCatalogHit = {
      ...CATALOG_HIT,
      collectionId: 42,
      feedUrl: 'https://example.com/feed.xml',
      title: 'Test Pod'
    }
    const itunes: ItunesClient = {
      search: vi.fn(async () => []),
      chart: vi.fn(async () => [
        { collectionId: 1001, title: 'Other Show' },
        { collectionId: 42, title: 'Test Pod' }
      ]),
      lookupIds: vi.fn(async () => [CATALOG_HIT, subHit])
    }
    const { db, podcasts } = service(fetchImpl, itunes)
    try {
      await podcasts.subscribe('https://example.com/feed.xml')
      const result = await podcasts.browseCategory('1488')
      expect(result.hits.map((h) => h.collectionId)).toEqual([1001])
      await expect(podcasts.browseCategory('nope')).rejects.toMatchObject({
        code: 'invalid-request'
      })
    } finally {
      db.close()
    }
  })

  it('refuses a feed body over the size cap', async () => {
    const oversize = 17 * 1024 * 1024
    const fetchImpl = vi.fn(
      async () =>
        new Response(FEED, {
          status: 200,
          headers: { 'content-length': String(oversize) }
        })
    ) as unknown as typeof fetch
    const { db, podcasts } = service(fetchImpl)
    try {
      await expect(podcasts.subscribe('https://example.com/feed.xml')).rejects.toMatchObject({
        code: 'io-error'
      })
    } finally {
      db.close()
    }
  })
})
