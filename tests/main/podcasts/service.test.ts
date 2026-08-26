import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
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

/** Same feed shape, but the enclosure points at a live local server. */
const WIRE_FEED = (port: string): string => `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Wire Pod</title>
    <itunes:author>Tester</itunes:author>
    <item>
      <title>Streamed</title>
      <guid>w1</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <enclosure url="http://127.0.0.1:${port}/ep.mp3" length="100000000" type="audio/mpeg" />
    </item>
  </channel>
</rss>`

let dir: string
let dbPath: string
let podcastsRoot: string
let artworkDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-podcasts-'))
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

  it('cancels an in-flight download back to remote, leaving no file', async () => {
    // A body that yields one chunk then hangs until the fetch signal aborts,
    // so the download sits in `downloading` long enough to be cancelled.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('feed.xml')) return new Response(FEED, { status: 200 })
      if (url.includes('hello.mp3')) {
        const signal = init?.signal
        // Mirror fetch: abort errors the body stream, whether it fired before
        // the stream was read (the download is 'downloading' the moment the
        // fetch starts, before any byte flows) or during streaming.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]))
            const fail = (): void => controller.error(new DOMException('aborted', 'AbortError'))
            if (signal?.aborted) fail()
            else signal?.addEventListener('abort', fail)
          }
        })
        return new Response(body, { status: 200, headers: { 'content-length': '4' } })
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof fetch

    const { db, podcasts } = service(fetchImpl)
    try {
      const podcast = await podcasts.subscribe('https://example.com/feed.xml')
      const episodes = await podcasts.listEpisodes({ podcastId: podcast.id, offset: 0, limit: 20 })
      const episodeId = episodes.episodes[0]!.id

      const downloadPromise = podcasts.downloadEpisode(episodeId)
      await vi.waitFor(async () => {
        const listed = await podcasts.listEpisodes({ podcastId: podcast.id, offset: 0, limit: 20 })
        expect(listed.episodes[0]?.downloadStatus).toBe('downloading')
      })

      const cancelled = await podcasts.cancelDownload(episodeId)
      expect(cancelled.downloadStatus).toBe('remote')

      // The original download call resolves as remote, not as a failure.
      const resolved = await downloadPromise
      expect(resolved.downloadStatus).toBe('remote')

      expect(await podcasts.resolveEpisodePath(episodeId)).toBeNull()
      const after = await podcasts.listEpisodes({ podcastId: podcast.id, offset: 0, limit: 20 })
      expect(after.episodes[0]?.downloadStatus).toBe('remote')
    } finally {
      db.close()
    }
  })

  it('cancels a real streaming download over the wire, aborting the socket', async () => {
    // End-to-end through the real global `fetch` — not a mock — so the abort
    // wiring is exercised as it runs in the app. The body never completes on
    // its own, so cancel resolving at all proves the abort reached the fetch:
    // a composite `AbortSignal.any` that got GC'd mid-transfer would hang here
    // until the test times out.
    const server: Server = createServer((req, res) => {
      if (req.url?.includes('/feed.xml')) {
        res.writeHead(200, { 'content-type': 'application/rss+xml' })
        res.end(WIRE_FEED(String((server.address() as AddressInfo).port)))
        return
      }
      // A slow, effectively endless body: one small chunk every 20ms, with a
      // large content-length so the download never completes on its own.
      res.writeHead(200, { 'content-length': '100000000' })
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 20)
      const stop = (): void => clearInterval(timer)
      req.on('close', stop)
      res.on('close', stop)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = String((server.address() as AddressInfo).port)

    const { db, podcasts } = service(((u: RequestInfo | URL, i?: RequestInit) =>
      fetch(u, i)) as unknown as typeof fetch)
    try {
      const podcast = await podcasts.subscribe(`http://127.0.0.1:${port}/feed.xml`)
      const episodes = await podcasts.listEpisodes({ podcastId: podcast.id, offset: 0, limit: 20 })
      const episodeId = episodes.episodes[0]!.id

      const downloadPromise = podcasts.downloadEpisode(episodeId)
      await vi.waitFor(async () => {
        const listed = await podcasts.listEpisodes({ podcastId: podcast.id, offset: 0, limit: 20 })
        expect(listed.episodes[0]?.downloadStatus).toBe('downloading')
      })

      // Must resolve promptly — a hang here is the exact bug this guards against.
      const cancelled = await podcasts.cancelDownload(episodeId)
      expect(cancelled.downloadStatus).toBe('remote')
      const resolved = await downloadPromise
      expect(resolved.downloadStatus).toBe('remote')

      expect(await podcasts.resolveEpisodePath(episodeId)).toBeNull()
    } finally {
      db.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
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

/** A Multi Pod feed with one `<item>` per day; higher day = newer episode. */
function multiFeed(days: readonly number[]): string {
  const items = days
    .map(
      (day) => `
    <item>
      <title>Episode ${day}</title>
      <guid>e${day}</guid>
      <pubDate>${new Date(Date.UTC(2024, 0, day)).toUTCString()}</pubDate>
      <enclosure url="https://cdn.example/e${day}.mp3" length="3" type="audio/mpeg" />
    </item>`
    )
    .join('')
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Multi Pod</title>
    <itunes:author>Tester</itunes:author>${items}
  </channel>
</rss>`
}

describe('SqlitePodcastService auto-download (P4)', () => {
  async function statusByGuid(
    podcasts: SqlitePodcastService,
    podcastId: number
  ): Promise<Map<string, string>> {
    const { episodes } = await podcasts.listEpisodes({ podcastId, offset: 0, limit: 50 })
    return new Map(episodes.map((e) => [e.guid, e.downloadStatus]))
  }

  /** Serves the current feed (mutable via the returned setter) and 3-byte mp3s. */
  function autoFetch(initial: string): {
    fetchImpl: typeof fetch
    setFeed: (xml: string) => void
  } {
    let feed = initial
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('feed.xml')) return new Response(feed, { status: 200 })
      if (url.endsWith('.mp3')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-length': '3' }
        })
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof fetch
    return { fetchImpl, setFeed: (xml) => (feed = xml) }
  }

  it('enabling fills the newest keepLast and leaves older episodes remote', async () => {
    const { fetchImpl } = autoFetch(multiFeed([1, 2, 3, 4, 5]))
    const { db, podcasts } = service(fetchImpl)
    try {
      const podcast = await podcasts.subscribe('https://example.com/feed.xml')
      expect(podcast.autoDownload).toBe(false)
      expect(podcast.keepLast).toBe(3)

      const updated = await podcasts.setAutoDownload(podcast.id, true)
      expect(updated.autoDownload).toBe(true)

      await vi.waitFor(async () => {
        const s = await statusByGuid(podcasts, podcast.id)
        expect(s.get('e5')).toBe('ready')
        expect(s.get('e4')).toBe('ready')
        expect(s.get('e3')).toBe('ready')
        expect(s.get('e2')).toBe('remote')
        expect(s.get('e1')).toBe('remote')
      })
    } finally {
      db.close()
    }
  })

  it('a refresh downloads a newer episode and prunes the oldest auto-download', async () => {
    const { fetchImpl, setFeed } = autoFetch(multiFeed([1, 2, 3]))
    const { db, podcasts } = service(fetchImpl)
    try {
      const podcast = await podcasts.subscribe('https://example.com/feed.xml')
      await podcasts.setAutoDownload(podcast.id, true)
      await vi.waitFor(async () => {
        const s = await statusByGuid(podcasts, podcast.id)
        expect([...s.values()].filter((v) => v === 'ready')).toHaveLength(3)
      })

      setFeed(multiFeed([1, 2, 3, 4]))
      await podcasts.refresh(podcast.id)

      await vi.waitFor(async () => {
        const s = await statusByGuid(podcasts, podcast.id)
        expect(s.get('e4')).toBe('ready')
        expect(s.get('e3')).toBe('ready')
        expect(s.get('e2')).toBe('ready')
        expect(s.get('e1')).toBe('remote') // pushed out of the newest-3 window
      })
    } finally {
      db.close()
    }
  })

  it('never prunes a manually-downloaded episode', async () => {
    const { fetchImpl, setFeed } = autoFetch(multiFeed([1, 2, 3, 4]))
    const { db, podcasts } = service(fetchImpl)
    try {
      const podcast = await podcasts.subscribe('https://example.com/feed.xml')
      await podcasts.setKeepLast(podcast.id, 2)

      // Manually download the oldest episode — a keep the prune must never touch.
      const before = await podcasts.listEpisodes({ podcastId: podcast.id, offset: 0, limit: 50 })
      const e1 = before.episodes.find((e) => e.guid === 'e1')!
      const manual = await podcasts.downloadEpisode(e1.id)
      expect(manual.downloadStatus).toBe('ready')

      await podcasts.setAutoDownload(podcast.id, true)
      await vi.waitFor(async () => {
        const s = await statusByGuid(podcasts, podcast.id)
        expect(s.get('e4')).toBe('ready') // auto
        expect(s.get('e3')).toBe('ready') // auto
        expect(s.get('e2')).toBe('remote')
        expect(s.get('e1')).toBe('ready') // manual, untouched
      })

      setFeed(multiFeed([1, 2, 3, 4, 5]))
      await podcasts.refresh(podcast.id)

      await vi.waitFor(async () => {
        const s = await statusByGuid(podcasts, podcast.id)
        expect(s.get('e5')).toBe('ready') // new auto
        expect(s.get('e4')).toBe('ready') // auto retained
        expect(s.get('e3')).toBe('remote') // oldest auto pruned
        expect(s.get('e1')).toBe('ready') // manual survives regardless
      })
    } finally {
      db.close()
    }
  })
})
