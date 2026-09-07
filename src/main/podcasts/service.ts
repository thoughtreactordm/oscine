import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import { OscineError } from '@shared/errors'
import { episodeUrl } from '@shared/ipc'
import type {
  BrowsePodcastCategoryResult,
  Episode,
  EpisodeAudioMetadata,
  EpisodeDownloadProgress,
  ImportOpmlResult,
  ListEpisodesQuery,
  ListEpisodesResult,
  ListRecentEpisodesQuery,
  ListRecentEpisodesResult,
  Podcast,
  PodcastCatalogHit,
  PodcastRecommendResult,
  PodcastRecommendShelf,
  PodcastShelfKind,
  SearchPodcastCatalogResult
} from '@shared/podcasts'
import { clampKeepLast, PODCAST_BROWSE_CATEGORIES } from '@shared/podcasts'
import type { ArtworkImageProcessor } from '../library/artworkProcessor'
import { WorkerArtworkImageProcessor } from '../library/artworkProcessor'
import {
  createItunesClient,
  normalizeCatalogFeedUrl,
  type ItunesClient,
  usefulGenreIds
} from './itunes'
import {
  createStallGuard,
  OSCINE_USER_AGENT,
  readCappedBytes,
  readCappedText,
  ResponseTooLargeError,
  TransferStalledError
} from '../net/http'
import type { NetworkConsent } from '../net'
import { parseOpml } from './opml'
import { episodeRelPath, podcastDirName, resolveEpisodeAbsPath } from './paths'
import { parsePodcastRss, RssParseError } from './rss'
import { PodcastStore } from './store'

const MAX_EPISODE_PAGE = 100
const MAX_RECENT_PAGE = 50
const MAX_CATALOG_SEARCH = 25
const MAX_RECOMMEND_SHELVES = 3
const MAX_RECOMMEND_PER_SHELF = 12
const MAX_CATEGORY_HITS = 24
const MAX_CHART_FETCH = 25
const MAX_SUBS_TO_ENRICH = 12
/** Discover remounts on every tab select; Apple's charts do not move that fast. */
const RECOMMEND_TTL_MS = 15 * 60 * 1000
const FEED_TIMEOUT_MS = 30_000
/** Headers must arrive inside this; after that only silence is fatal. */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 60_000
/** A host that sends nothing for this long has gone away. */
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000
/** Floor between download-progress events, so a fast transfer cannot flood the renderer. */
const PROGRESS_THROTTLE_MS = 150
/** Feeds with thousands of episodes reach a few MB; nothing legitimate is near this. */
const MAX_FEED_BYTES = 16 * 1024 * 1024
const MAX_ARTWORK_BYTES = 12 * 1024 * 1024
/** A ceiling no real episode reaches, so a runaway body cannot fill the disk. */
const MAX_EPISODE_BYTES = 2 * 1024 * 1024 * 1024

export interface PodcastService {
  listPodcasts(): Promise<Podcast[]>
  getPodcast(podcastId: number): Promise<Podcast | null>
  subscribe(feedUrl: string): Promise<Podcast>
  unsubscribe(podcastId: number): Promise<void>
  refresh(podcastId: number): Promise<Podcast>
  refreshAll(): Promise<Podcast[]>
  listEpisodes(query: ListEpisodesQuery): Promise<ListEpisodesResult>
  listRecent(query: ListRecentEpisodesQuery): Promise<ListRecentEpisodesResult>
  downloadEpisode(episodeId: number): Promise<Episode>
  /** Aborts a download in progress; the episode returns to remote (idle). */
  cancelDownload(episodeId: number): Promise<Episode>
  /** Deletes the local file; the episode stays in the feed list as remote. */
  deleteDownload(episodeId: number): Promise<Episode>
  /** Deletes every local file for a show; the subscription stays. */
  clearDownloads(podcastId: number): Promise<Podcast>
  setPlayed(episodeId: number, played: boolean): Promise<Episode>
  /** Toggle auto-download; enabling fills the newest `keepLast` in the background. */
  setAutoDownload(podcastId: number, enabled: boolean): Promise<Podcast>
  /** Set the retention window; re-fills or prunes to match if auto-download is on. */
  setKeepLast(podcastId: number, keepLast: number): Promise<Podcast>
  importOpml(xml: string): Promise<ImportOpmlResult>
  resolveEpisodePath(episodeId: number): Promise<string | null>
  getEpisodeFileUrl(episodeId: number): Promise<string>
  getEpisodeAudioMetadata(episodeId: number): Promise<EpisodeAudioMetadata>
  searchCatalog(term: string, limit?: number): Promise<SearchPodcastCatalogResult>
  recommend(): Promise<PodcastRecommendResult>
  browseCategory(genreId: string): Promise<BrowsePodcastCategoryResult>
}

export interface PodcastServiceDeps {
  db: Database.Database
  podcastsRoot: string
  artworkCacheDir: string
  fetchImpl?: typeof fetch
  itunes?: ItunesClient
  /**
   * **D14**'s consent gate, handed to the catalogue client so every Apple
   * request refuses at the socket when external lookups are off. Absent only
   * when a test injects its own `itunes`.
   */
  consent?: NetworkConsent
  artworkProcessor?: ArtworkImageProcessor
  onDownloadProgress?: (progress: EpisodeDownloadProgress) => void
  now?: () => number
}

/**
 * Subscribe, refresh, download. Network and filesystem stay here; the renderer
 * only sees ids and opaque `oscine://` URLs.
 */
export class SqlitePodcastService implements PodcastService {
  private readonly store: PodcastStore
  private readonly podcastsRoot: string
  private readonly artworkCacheDir: string
  private readonly fetchImpl: typeof fetch
  private readonly itunes: ItunesClient
  private readonly artwork: ArtworkImageProcessor
  private readonly onDownloadProgress: (progress: EpisodeDownloadProgress) => void
  private readonly now: () => number
  private readonly downloading = new Set<number>()
  private readonly downloadJobs = new Map<number, Promise<Episode>>()
  /** User-driven cancels for in-flight downloads, keyed by episode id. */
  private readonly downloadAborts = new Map<number, () => void>()
  private recommendCache: { at: number; result: PodcastRecommendResult } | null = null
  private readonly categoryCache = new Map<string, { at: number; hits: PodcastCatalogHit[] }>()

  constructor(deps: PodcastServiceDeps) {
    this.store = new PodcastStore(deps.db)
    this.podcastsRoot = deps.podcastsRoot
    this.artworkCacheDir = deps.artworkCacheDir
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.itunes =
      deps.itunes ??
      createItunesClient({
        fetchImpl: this.fetchImpl,
        userAgent: OSCINE_USER_AGENT,
        consent: deps.consent
      })
    this.artwork = deps.artworkProcessor ?? new WorkerArtworkImageProcessor()
    this.onDownloadProgress = deps.onDownloadProgress ?? (() => undefined)
    this.now = deps.now ?? (() => Date.now())
  }

  async listPodcasts(): Promise<Podcast[]> {
    return this.store.listPodcasts()
  }

  async getPodcast(podcastId: number): Promise<Podcast | null> {
    return this.store.getPodcast(podcastId)
  }

  async subscribe(feedUrl: string): Promise<Podcast> {
    const url = normalizeFeedUrl(feedUrl)
    const existing = this.store.findByFeedUrl(url)
    if (existing) {
      throw new OscineError('conflict', 'Already subscribed to that feed.')
    }

    const feed = await this.fetchFeed(url)
    const subscribedAt = this.now()
    const podcastId = this.store.insertPodcast({
      feedUrl: url,
      title: feed.title,
      author: feed.author,
      description: feed.description,
      siteUrl: feed.siteUrl,
      artworkUrl: feed.artworkUrl,
      subscribedAt
    })
    this.store.upsertEpisodes(podcastId, feed.episodes)
    this.store.updatePodcastFromFeed(podcastId, feed, subscribedAt, null)
    await this.cacheArtwork(podcastId, feed.artworkUrl, url)

    const podcast = this.store.getPodcast(podcastId)
    if (!podcast) throw new OscineError('internal', 'Subscription vanished after insert.')
    this.invalidateDiscoverCaches()
    return podcast
  }

  async unsubscribe(podcastId: number): Promise<void> {
    const podcast = this.store.getPodcast(podcastId)
    if (!podcast) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')

    // Always the show directory named from id+title — not only when rows still
    // carry rel_paths — so unsub never leaves orphan audio behind.
    const showDir = join(this.podcastsRoot, podcastDirName(podcastId, podcast.title))
    this.store.deletePodcast(podcastId)
    this.invalidateDiscoverCaches()
    await rm(showDir, { recursive: true, force: true }).catch(() => undefined)
  }

  async refresh(podcastId: number): Promise<Podcast> {
    const podcast = this.store.getPodcast(podcastId)
    if (!podcast) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')

    try {
      const feed = await this.fetchFeed(podcast.feedUrl)
      const fetchedAt = this.now()
      this.store.upsertEpisodes(podcastId, feed.episodes)
      this.store.updatePodcastFromFeed(podcastId, feed, fetchedAt, null)
      await this.cacheArtwork(podcastId, feed.artworkUrl, podcast.feedUrl)
    } catch (error) {
      const message = errorMessage(error)
      this.store.setPodcastError(podcastId, message)
      throw error instanceof OscineError ? error : new OscineError('io-error', message)
    }

    // A refresh may have pulled in newer episodes; keep the newest `keepLast`
    // on disk. Runs after the feed write, in the background, so a slow download
    // never holds up the refresh the caller is awaiting.
    if (podcast.autoDownload) void this.fillAutoDownloads(podcastId).catch(() => undefined)

    const updated = this.store.getPodcast(podcastId)
    if (!updated) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')
    return updated
  }

  async refreshAll(): Promise<Podcast[]> {
    const all = this.store.listPodcasts()
    for (const podcast of all) {
      try {
        await this.refresh(podcast.id)
      } catch {
        // Per-show errors land on `lastError`; keep going.
      }
    }
    return this.store.listPodcasts()
  }

  async listEpisodes(query: ListEpisodesQuery): Promise<ListEpisodesResult> {
    if (!this.store.getPodcast(query.podcastId)) {
      throw new OscineError('not-found', 'That podcast is not in your subscriptions.')
    }
    return this.store.listEpisodes(
      {
        podcastId: query.podcastId,
        offset: query.offset,
        limit: Math.min(Math.max(1, query.limit), MAX_EPISODE_PAGE)
      },
      this.downloading
    )
  }

  async listRecent(query: ListRecentEpisodesQuery): Promise<ListRecentEpisodesResult> {
    return this.store.listRecent(
      {
        offset: query.offset,
        limit: Math.min(Math.max(1, query.limit), MAX_RECENT_PAGE)
      },
      this.downloading
    )
  }

  async downloadEpisode(episodeId: number): Promise<Episode> {
    const episode = await this.enqueueDownload(episodeId)
    // A hand-pulled download is manually kept: clear any auto flag so prune,
    // which only ever touches auto-downloaded rows, can never remove it.
    if (episode.downloadStatus === 'ready') this.store.setAutoDownloaded(episodeId, false)
    return episode
  }

  /** Deduped download job shared by the manual and auto-download paths. */
  private enqueueDownload(episodeId: number): Promise<Episode> {
    const existing = this.downloadJobs.get(episodeId)
    if (existing) return existing

    const job = this.runDownload(episodeId).finally(() => {
      this.downloadJobs.delete(episodeId)
      this.downloading.delete(episodeId)
      this.downloadAborts.delete(episodeId)
    })
    this.downloadJobs.set(episodeId, job)
    return job
  }

  /**
   * Abort a download that is currently running. The in-flight fetch is aborted,
   * `runDownload` unwinds through its cancel path (partial file removed, no
   * failure recorded), and the episode is left as `remote` so the action button
   * returns to Download. A no-op with the current row when nothing is in flight.
   */
  async cancelDownload(episodeId: number): Promise<Episode> {
    const cancel = this.downloadAborts.get(episodeId)
    if (cancel) {
      cancel()
      // Let the running job settle so the store and `downloading` set are
      // consistent before we read the episode back.
      await this.downloadJobs.get(episodeId)?.catch(() => undefined)
    }
    const episode = this.store.getEpisode(episodeId, this.downloading)
    if (!episode) throw new OscineError('not-found', 'That episode is gone.')
    return episode
  }

  async deleteDownload(episodeId: number): Promise<Episode> {
    const pathRow = this.store.getEpisodePath(episodeId)
    if (!pathRow) throw new OscineError('not-found', 'That episode is gone.')

    if (pathRow.rel_path) {
      const abs = resolveEpisodeAbsPath(this.podcastsRoot, pathRow.rel_path)
      await unlink(abs).catch(() => undefined)
    }
    this.store.clearDownload(episodeId)
    this.downloading.delete(episodeId)
    this.downloadJobs.delete(episodeId)

    const episode = this.store.getEpisode(episodeId, this.downloading)
    if (!episode) throw new OscineError('not-found', 'That episode is gone.')

    const podcastId = episode.podcastId
    this.onDownloadProgress({
      episodeId,
      podcastId,
      status: 'remote',
      fraction: null
    })
    return episode
  }

  async clearDownloads(podcastId: number): Promise<Podcast> {
    const podcast = this.store.getPodcast(podcastId)
    if (!podcast) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')

    const showDir = join(this.podcastsRoot, podcastDirName(podcastId, podcast.title))
    await rm(showDir, { recursive: true, force: true }).catch(() => undefined)
    this.store.clearDownloadsForPodcast(podcastId)

    const updated = this.store.getPodcast(podcastId)
    if (!updated) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')
    return updated
  }

  async setPlayed(episodeId: number, played: boolean): Promise<Episode> {
    if (!this.store.getEpisode(episodeId, this.downloading)) {
      throw new OscineError('not-found', 'That episode is gone.')
    }
    this.store.setPlayed(episodeId, played)
    const episode = this.store.getEpisode(episodeId, this.downloading)
    if (!episode) throw new OscineError('not-found', 'That episode is gone.')
    return episode
  }

  async setAutoDownload(podcastId: number, enabled: boolean): Promise<Podcast> {
    const podcast = this.store.getPodcast(podcastId)
    if (!podcast) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')
    this.store.setAutoDownload(podcastId, enabled)
    // Enabling seeds the window immediately; disabling leaves existing files be
    // (removal is the user's call, via the trash affordances). Downloads run in
    // the background so the toggle returns at once and the row reports progress.
    if (enabled) void this.fillAutoDownloads(podcastId).catch(() => undefined)
    return this.requirePodcast(podcastId)
  }

  async setKeepLast(podcastId: number, keepLast: number): Promise<Podcast> {
    const podcast = this.store.getPodcast(podcastId)
    if (!podcast) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')
    this.store.setKeepLast(podcastId, clampKeepLast(keepLast))
    // A larger N fills, a smaller N prunes; `fillAutoDownloads` does both. With
    // auto-download off, only trim what auto already retained — never fetch.
    if (podcast.autoDownload) void this.fillAutoDownloads(podcastId).catch(() => undefined)
    else await this.pruneAutoDownloads(podcastId)
    return this.requirePodcast(podcastId)
  }

  async importOpml(xml: string): Promise<ImportOpmlResult> {
    const outlines = parseOpml(xml)
    if (outlines.length === 0) {
      throw new OscineError('invalid-request', 'No podcast feeds found in that OPML file.')
    }
    const subscribed: Podcast[] = []
    const failed: ImportOpmlResult['failed'] = []
    for (const outline of outlines) {
      try {
        if (this.store.findByFeedUrl(normalizeFeedUrl(outline.feedUrl))) continue
        subscribed.push(await this.subscribe(outline.feedUrl))
      } catch (error) {
        failed.push({ feedUrl: outline.feedUrl, message: errorMessage(error) })
      }
    }
    return { subscribed, failed }
  }

  async resolveEpisodePath(episodeId: number): Promise<string | null> {
    const row = this.store.getEpisodePath(episodeId)
    if (!row?.rel_path) return null
    const abs = resolveEpisodeAbsPath(this.podcastsRoot, row.rel_path)
    try {
      await stat(abs)
      return abs
    } catch {
      return null
    }
  }

  async getEpisodeFileUrl(episodeId: number): Promise<string> {
    if ((await this.resolveEpisodePath(episodeId)) === null) {
      throw new OscineError('not-found', 'That episode is not downloaded.')
    }
    return episodeUrl(episodeId)
  }

  async getEpisodeAudioMetadata(episodeId: number): Promise<EpisodeAudioMetadata> {
    const row = this.store.getEpisodePath(episodeId)
    if (!row?.rel_path) {
      throw new OscineError('not-found', 'That episode is not downloaded.')
    }
    return {
      episodeId,
      durationSec: row.duration_ms === null ? null : row.duration_ms / 1000,
      encodedBytes: row.file_size ?? 0,
      sampleRateHz: null,
      channels: null,
      bitDepth: null,
      codec: null
    }
  }

  async searchCatalog(
    term: string,
    limit = MAX_CATALOG_SEARCH
  ): Promise<SearchPodcastCatalogResult> {
    const q = term.trim()
    if (q.length < 2) return { hits: [] }
    const hits = await this.itunes.search(q, Math.min(limit, MAX_CATALOG_SEARCH))
    return { hits }
  }

  /**
   * Shelves for Discover.
   *
   * With subscriptions: weight Apple genres across them and pull top charts for
   * the strongest few. Without: fall back to a fixed set of popular categories,
   * because a Discover tab that is empty until you already have taste is not a
   * discovery surface. Either way each shelf finishes with a batch lookup —
   * chart RSS carries no feedUrl — and already-subscribed feeds are dropped.
   *
   * Cached briefly: the tab remounts every time it is selected, and eighteen
   * round trips to Apple per glance is not acceptable.
   */
  async recommend(): Promise<PodcastRecommendResult> {
    const cached = this.recommendCache
    if (cached && this.now() - cached.at < RECOMMEND_TTL_MS) return cached.result

    const subs = this.store.listPodcasts()
    const subscribed = this.subscribedFeedKeys()
    const seenCollectionIds = new Set<number>()

    const topGenres = subs.length === 0 ? [] : await this.weightSubscriptionGenres(subs)
    const coldStart = topGenres.length === 0

    const wanted: Array<{
      id: string
      kind: PodcastShelfKind
      title: string
      reason: string | null
    }> = coldStart
      ? PODCAST_BROWSE_CATEGORIES.slice(0, MAX_RECOMMEND_SHELVES).map((category) => ({
          id: category.genreId,
          kind: 'popular' as const,
          title: category.name,
          reason: 'Popular right now'
        }))
      : topGenres.map(([genreId, meta]) => ({
          id: genreId,
          kind: 'genre' as const,
          title: meta.name,
          reason: `Because you follow ${meta.count} ${meta.count === 1 ? 'show' : 'shows'} in this genre`
        }))

    const shelves: PodcastRecommendShelf[] = []
    for (const spec of wanted) {
      const hits = await this.chartShelfHits(spec.id, subscribed, seenCollectionIds)
      if (hits.length === 0) continue
      shelves.push({ ...spec, hits })
    }

    const result: PodcastRecommendResult = { shelves, coldStart }
    this.recommendCache = { at: this.now(), result }
    return result
  }

  /** Top charts for one category the user picked off the rail. */
  async browseCategory(genreId: string): Promise<BrowsePodcastCategoryResult> {
    const id = genreId.trim()
    if (!/^\d+$/.test(id)) {
      throw new OscineError('invalid-request', 'That is not a known podcast category.')
    }
    const cached = this.categoryCache.get(id)
    if (cached && this.now() - cached.at < RECOMMEND_TTL_MS) return { hits: cached.hits }

    const hits = await this.chartShelfHits(
      id,
      this.subscribedFeedKeys(),
      new Set(),
      MAX_CATEGORY_HITS
    )
    this.categoryCache.set(id, { at: this.now(), hits })
    return { hits }
  }

  /**
   * Which Apple genres the user's subscriptions cluster in, strongest first.
   *
   * Each subscription costs a catalogue search to resolve to a hit with genre
   * ids on it, so they run concurrently — sequentially this was the whole
   * latency of the Discover tab.
   */
  private async weightSubscriptionGenres(
    subs: readonly Podcast[]
  ): Promise<Array<[string, { name: string; count: number }]>> {
    const matches = await Promise.all(
      subs.slice(0, MAX_SUBS_TO_ENRICH).map(async (sub) => {
        try {
          const hits = await this.itunes.search(sub.title, 8)
          return (
            hits.find(
              (hit) => normalizeCatalogFeedUrl(hit.feedUrl) === normalizeCatalogFeedUrl(sub.feedUrl)
            ) ??
            hits.find((hit) => titlesLooselyMatch(hit.title, sub.title)) ??
            null
          )
        } catch {
          // One failed enrichment must not cost the whole shelf set.
          return null
        }
      })
    )

    const tallies = new Map<string, { name: string; count: number }>()
    for (const match of matches) {
      if (!match) continue
      const nameById = new Map<string, string>()
      for (let i = 0; i < match.genreIds.length; i++) {
        const id = match.genreIds[i]!
        nameById.set(id, match.genres[i] ?? match.primaryGenreName ?? id)
      }
      for (const id of usefulGenreIds(match)) {
        const prev = tallies.get(id)
        const name = nameById.get(id) ?? match.primaryGenreName ?? id
        tallies.set(id, { name, count: (prev?.count ?? 0) + 1 })
      }
    }

    return [...tallies.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, MAX_RECOMMEND_SHELVES)
  }

  /**
   * Chart entries for one genre, resolved to full catalogue hits.
   *
   * `seen` is shared across a recommend() run so the same show does not appear
   * on two shelves; pass a fresh set for a standalone browse.
   */
  private async chartShelfHits(
    genreId: string,
    subscribed: ReadonlySet<string>,
    seen: Set<number>,
    max = MAX_RECOMMEND_PER_SHELF
  ): Promise<PodcastCatalogHit[]> {
    let chart: Array<{ collectionId: number; title: string }>
    try {
      chart = await this.itunes.chart(genreId, MAX_CHART_FETCH)
    } catch {
      return []
    }
    const ids = chart.map((entry) => entry.collectionId).filter((id) => !seen.has(id))
    if (ids.length === 0) return []

    let lookedUp: PodcastCatalogHit[]
    try {
      lookedUp = await this.itunes.lookupIds(ids)
    } catch {
      return []
    }

    const byId = new Map(lookedUp.map((hit) => [hit.collectionId, hit]))
    const hits: PodcastCatalogHit[] = []
    for (const id of ids) {
      const hit = byId.get(id)
      if (!hit) continue
      if (subscribed.has(normalizeCatalogFeedUrl(hit.feedUrl))) continue
      if (seen.has(hit.collectionId)) continue
      seen.add(hit.collectionId)
      hits.push(hit)
      if (hits.length >= max) break
    }
    return hits
  }

  private subscribedFeedKeys(): Set<string> {
    return new Set(this.store.listPodcasts().map((p) => normalizeCatalogFeedUrl(p.feedUrl)))
  }

  /** Subscribing changes both the genre weights and the already-have filter. */
  private invalidateDiscoverCaches(): void {
    this.recommendCache = null
    this.categoryCache.clear()
  }

  private requirePodcast(podcastId: number): Podcast {
    const podcast = this.store.getPodcast(podcastId)
    if (!podcast) throw new OscineError('not-found', 'That podcast is not in your subscriptions.')
    return podcast
  }

  /**
   * Bring the newest `keepLast` episodes of a show onto disk, then prune.
   *
   * Only the currently-remote ones are fetched: an episode already downloaded —
   * by hand or by a previous fill — is left as it is, so a manual keep is never
   * re-fetched or reclassified. Prune afterwards drops auto-downloads that the
   * window has moved past. Downloads run one at a time to spare the network.
   */
  private async fillAutoDownloads(podcastId: number): Promise<void> {
    const keepLast = this.store.getKeepLast(podcastId)
    for (const episodeId of this.store.latestEpisodeIds(podcastId, keepLast)) {
      if (this.store.getEpisodePath(episodeId)?.rel_path) continue
      await this.autoDownload(episodeId)
    }
    await this.pruneAutoDownloads(podcastId)
  }

  /** Download one episode and, if it lands, mark it auto-retained. */
  private async autoDownload(episodeId: number): Promise<void> {
    try {
      const episode = await this.enqueueDownload(episodeId)
      if (episode.downloadStatus === 'ready') this.store.setAutoDownloaded(episodeId, true)
    } catch {
      // One failed auto-download must not abort the rest of the window.
    }
  }

  /** Delete auto-downloaded files past the newest `keepLast`; keep manuals. */
  private async pruneAutoDownloads(podcastId: number): Promise<void> {
    const keepLast = this.store.getKeepLast(podcastId)
    for (const episodeId of this.store.autoDownloadedBeyond(podcastId, keepLast)) {
      await this.purgeDownload(episodeId)
    }
  }

  /** Remove an episode's local file and reset it to remote (no error state). */
  private async purgeDownload(episodeId: number): Promise<void> {
    const pathRow = this.store.getEpisodePath(episodeId)
    if (!pathRow) return
    if (pathRow.rel_path) {
      const abs = resolveEpisodeAbsPath(this.podcastsRoot, pathRow.rel_path)
      await unlink(abs).catch(() => undefined)
    }
    const episode = this.store.getEpisode(episodeId, this.downloading)
    this.store.clearDownload(episodeId)
    if (episode) {
      this.onDownloadProgress({
        episodeId,
        podcastId: episode.podcastId,
        status: 'remote',
        fraction: null
      })
    }
  }

  private async runDownload(episodeId: number): Promise<Episode> {
    const episode = this.store.getEpisode(episodeId, this.downloading)
    if (!episode) throw new OscineError('not-found', 'That episode is gone.')

    const pathRow = this.store.getEpisodePath(episodeId)
    if (!pathRow) throw new OscineError('not-found', 'That episode is gone.')
    if (pathRow.rel_path) {
      const abs = resolveEpisodeAbsPath(this.podcastsRoot, pathRow.rel_path)
      try {
        await stat(abs)
        return episode
      } catch {
        // Re-download if the file vanished.
      }
    }

    const enclosure = this.store.getEnclosureUrl(episodeId)
    if (!enclosure) throw new OscineError('not-found', 'That episode is gone.')

    const podcastTitle = this.store.podcastTitle(enclosure.podcastId) ?? 'podcast'
    const relPath = episodeRelPath(
      enclosure.podcastId,
      podcastTitle,
      episodeId,
      episode.title,
      enclosure.enclosureUrl
    )
    const absPath = resolveEpisodeAbsPath(this.podcastsRoot, relPath)

    this.downloading.add(episodeId)
    this.onDownloadProgress({
      episodeId,
      podcastId: enclosure.podcastId,
      status: 'downloading',
      fraction: 0
    })

    const guard = createStallGuard(DOWNLOAD_CONNECT_TIMEOUT_MS)
    // A user cancel unwinds the transfer two ways, because a `fetch` abort alone
    // is not reliably honoured across runtimes: it aborts the guard's controller
    // (the signal `fetch` is wired to, which covers the pre-body window) AND
    // destroys the body stream `pipeline` is draining (which rejects it at once
    // once bytes are flowing). `cancelledByUser` distinguishes this from a stall.
    let cancelledByUser = false
    let activeBody: Readable | null = null
    this.downloadAborts.set(episodeId, () => {
      cancelledByUser = true
      guard.abort()
      activeBody?.destroy(new OscineError('cancelled', 'Download canceled.'))
    })
    try {
      await mkdir(dirname(absPath), { recursive: true })
      const response = await this.fetchImpl(enclosure.enclosureUrl, {
        signal: guard.signal,
        headers: { 'user-agent': OSCINE_USER_AGENT }
      })
      if (!response.ok || !response.body) {
        throw new OscineError('io-error', `Download failed (${response.status}).`)
      }

      const total = Number(response.headers.get('content-length'))
      const hasTotal = Number.isFinite(total) && total > 0
      if (hasTotal && total > MAX_EPISODE_BYTES) {
        throw new OscineError('io-error', 'That episode is too large to download.')
      }
      let received = 0

      const nodeBody = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      activeBody = nodeBody
      // A user cancel between here and the first chunk still needs to bite.
      if (cancelledByUser) nodeBody.destroy(new OscineError('cancelled', 'Download canceled.'))
      // Coalesce progress to a steady cadence. A fast multi-MB episode arrives in
      // hundreds of chunks a second; emitting one IPC event per chunk floods the
      // renderer (every event re-renders the episode list) and starves it of the
      // frames it needs to service a Cancel click — so the download becomes
      // effectively uncancellable until it finishes. The terminal ready/failed/
      // remote events below are always sent, so the final state is never dropped.
      let lastEmit = 0
      nodeBody.on('data', (chunk: Buffer) => {
        guard.keepAlive(DOWNLOAD_STALL_TIMEOUT_MS)
        received += chunk.length
        if (received > MAX_EPISODE_BYTES) {
          nodeBody.destroy(new OscineError('io-error', 'That episode is too large to download.'))
          return
        }
        const at = this.now()
        if (at - lastEmit < PROGRESS_THROTTLE_MS) return
        lastEmit = at
        this.onDownloadProgress({
          episodeId,
          podcastId: enclosure.podcastId,
          status: 'downloading',
          fraction: hasTotal ? Math.min(1, received / total) : null
        })
      })

      await pipeline(nodeBody, createWriteStream(absPath))
      guard.release()
      const size = (await stat(absPath)).size
      this.store.markDownloaded(episodeId, relPath, size, this.now())
      this.downloading.delete(episodeId)
      this.onDownloadProgress({
        episodeId,
        podcastId: enclosure.podcastId,
        status: 'ready',
        fraction: 1
      })
    } catch (error) {
      guard.release()
      this.downloading.delete(episodeId)
      await unlink(absPath).catch(() => undefined)
      if (cancelledByUser) {
        // A user cancel is not a failure: clear the partial row back to remote
        // and resolve with the idle episode so the caller's Download click ends
        // quietly rather than surfacing an error toast.
        this.store.clearDownload(episodeId)
        this.onDownloadProgress({
          episodeId,
          podcastId: enclosure.podcastId,
          status: 'remote',
          fraction: null
        })
        const remote = this.store.getEpisode(episodeId, this.downloading)
        if (!remote) throw new OscineError('not-found', 'That episode is gone.')
        return remote
      }
      const message =
        error instanceof TransferStalledError || guard.signal.aborted
          ? 'The download stopped responding.'
          : errorMessage(error)
      this.store.markDownloadFailed(episodeId, message)
      this.onDownloadProgress({
        episodeId,
        podcastId: enclosure.podcastId,
        status: 'failed',
        fraction: null
      })
      throw error instanceof OscineError ? error : new OscineError('io-error', message)
    }

    const ready = this.store.getEpisode(episodeId, this.downloading)
    if (!ready) throw new OscineError('not-found', 'That episode is gone.')
    return ready
  }

  private async fetchFeed(feedUrl: string) {
    let response: Response
    try {
      response = await this.fetchImpl(feedUrl, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: {
          accept: 'application/rss+xml, application/xml, text/xml, */*',
          'user-agent': OSCINE_USER_AGENT
        }
      })
    } catch {
      throw new OscineError('io-error', 'Could not reach that feed.')
    }
    if (!response.ok) {
      throw new OscineError('io-error', `Feed returned HTTP ${response.status}.`)
    }
    let xml: string
    try {
      xml = await readCappedText(response, MAX_FEED_BYTES)
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        throw new OscineError('io-error', 'That feed is too large to read.')
      }
      throw new OscineError('io-error', 'Could not read that feed.')
    }
    try {
      return parsePodcastRss(xml)
    } catch (error) {
      if (error instanceof RssParseError) {
        throw new OscineError('invalid-request', error.message)
      }
      throw error
    }
  }

  private async cacheArtwork(
    podcastId: number,
    artworkUrl: string | null,
    feedUrl?: string
  ): Promise<void> {
    const absolute = absolutizeUrl(artworkUrl, feedUrl)
    if (!absolute) return
    try {
      const response = await this.fetchImpl(absolute, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: { 'user-agent': OSCINE_USER_AGENT }
      })
      if (!response.ok) {
        console.warn(`[podcasts] artwork HTTP ${response.status} for podcast ${podcastId}`)
        return
      }
      const buffer = await readCappedBytes(response, MAX_ARTWORK_BYTES)
      if (buffer.byteLength === 0) return
      const hash = createHash('sha256').update(buffer).digest('hex')
      // `generate` returns whether it *wrote*, not whether the hash is usable —
      // existing thumbnails for the same bytes correctly return false.
      await this.artwork.generate(this.artworkCacheDir, hash, buffer)
      if (await this.artwork.validate(this.artworkCacheDir, hash)) {
        this.store.setArtworkHash(podcastId, hash)
      }
    } catch (error) {
      // Artwork is decorative; a failed cover must not fail subscribe/refresh.
      console.warn(
        `[podcasts] artwork cache failed for podcast ${podcastId}:`,
        error instanceof Error ? error.message : error
      )
    }
  }
}

/** Resolve feed-relative image URLs (and reject non-http). */
function absolutizeUrl(raw: string | null | undefined, base?: string): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  try {
    const url = base ? new URL(trimmed, base) : new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new OscineError('invalid-request', 'That is not a valid feed URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OscineError('invalid-request', 'Feed URL must be http or https.')
  }
  return url.toString()
}

function errorMessage(error: unknown): string {
  if (error instanceof OscineError) return error.message
  if (error instanceof Error && error.message) return 'Could not complete that podcast request.'
  return 'Could not complete that podcast request.'
}

function titlesLooselyMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  const left = norm(a)
  const right = norm(b)
  if (left === '' || right === '') return false
  return left === right || left.includes(right) || right.includes(left)
}
