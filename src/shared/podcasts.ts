/**
 * Podcast domain types crossing the IPC boundary.
 *
 * Podcasts are not library tracks (D14 stays intact: Library facets stay music).
 * Episodes download into a machine-local podcasts directory and play from disk;
 * the renderer never sees a path or an enclosure URL used as a playback source.
 */

import type { ArtworkUrls } from './library'

/** A subscribed show. */
export interface Podcast {
  id: number
  feedUrl: string
  title: string
  author: string | null
  description: string | null
  siteUrl: string | null
  artwork: ArtworkUrls
  /** ISO 8601, UTC. */
  subscribedAt: string
  /** ISO 8601, UTC, or null before the first successful fetch. */
  lastFetchedAt: string | null
  /** Last refresh failure, cleared on success. Safe to show. */
  lastError: string | null
  episodeCount: number
  undownloadedCount: number
  unplayedCount: number
}

export type EpisodeDownloadStatus = 'remote' | 'downloading' | 'ready' | 'failed'

/** One episode of a subscribed show. */
export interface Episode {
  id: number
  podcastId: number
  guid: string
  title: string
  description: string | null
  /** ISO 8601, UTC, or null when the feed omitted pubDate. */
  pubDate: string | null
  durationMs: number | null
  downloadStatus: EpisodeDownloadStatus
  played: boolean
  progressMs: number
  /** Present on recent-across-shows lists so the sidebar can label the show. */
  podcastTitle: string
  podcastArtwork: ArtworkUrls
}

export interface ListEpisodesQuery {
  podcastId: number
  /** Inclusive start, 0-based. */
  offset: number
  /** Page size; capped in main. */
  limit: number
}

export interface ListEpisodesResult {
  total: number
  episodes: Episode[]
}

export interface ListRecentEpisodesQuery {
  offset: number
  limit: number
}

export interface ListRecentEpisodesResult {
  total: number
  episodes: Episode[]
}

export interface SubscribePodcastRequest {
  /** Absolute http(s) feed URL. */
  feedUrl: string
}

export interface ImportOpmlResult {
  subscribed: Podcast[]
  /** Feed URLs that failed, with a safe message each. */
  failed: Array<{ feedUrl: string; message: string }>
}

/**
 * A show from Apple's podcast catalogue (search or charts).
 *
 * Not a subscription — `feedUrl` is what `podcasts.subscribe` takes. Artwork is
 * a remote https URL (Apple CDN); Discover is the only surface that renders it.
 */
export interface PodcastCatalogHit {
  collectionId: number
  feedUrl: string
  title: string
  author: string | null
  artworkUrl: string | null
  primaryGenreName: string | null
  genres: string[]
  genreIds: string[]
}

export interface SearchPodcastCatalogQuery {
  /** Free-text show / author term. */
  term: string
  /** Page size; capped in main. */
  limit?: number
}

export interface SearchPodcastCatalogResult {
  hits: PodcastCatalogHit[]
}

/**
 * Where a Discover shelf came from.
 *
 * The kind is what lets Discover grow a second and third recommendation source
 * without another contract change: the renderer groups and labels by kind and
 * does not care how main derived the hits.
 */
export type PodcastShelfKind =
  /** Charts for a genre the user's own subscriptions cluster in. */
  | 'genre'
  /** Charts for a category the user explicitly asked to browse. */
  | 'category'
  /** Generic popular charts, for when there is nothing to learn from yet. */
  | 'popular'

/** One horizontal row of catalogue suggestions. */
export interface PodcastRecommendShelf {
  /** Stable within a result — the Apple genre id for chart-backed shelves. */
  id: string
  kind: PodcastShelfKind
  title: string
  /** Why this shelf is here, in the user's terms. Null when self-evident. */
  reason: string | null
  hits: PodcastCatalogHit[]
}

export interface PodcastRecommendResult {
  shelves: PodcastRecommendShelf[]
  /** No subscriptions to learn from yet — shelves are generic popular charts. */
  coldStart: boolean
}

/** A browsable Apple podcast genre. */
export interface PodcastCategory {
  genreId: string
  name: string
}

/**
 * The category rail on Discover.
 *
 * Apple's top-level podcast genre ids, which have been stable for years. Held
 * here rather than fetched because the rail must render before any network
 * call resolves — a Discover tab that is blank until Apple answers is the
 * thing this list exists to prevent.
 */
export const PODCAST_BROWSE_CATEGORIES: readonly PodcastCategory[] = [
  { genreId: '1488', name: 'True Crime' },
  { genreId: '1489', name: 'News' },
  { genreId: '1303', name: 'Comedy' },
  { genreId: '1324', name: 'Society & Culture' },
  { genreId: '1318', name: 'Technology' },
  { genreId: '1321', name: 'Business' },
  { genreId: '1487', name: 'History' },
  { genreId: '1533', name: 'Science' },
  { genreId: '1512', name: 'Health & Fitness' },
  { genreId: '1301', name: 'Arts' },
  { genreId: '1545', name: 'Sports' },
  { genreId: '1310', name: 'Music' },
  { genreId: '1304', name: 'Education' },
  { genreId: '1483', name: 'Fiction' },
  { genreId: '1305', name: 'Kids & Family' },
  { genreId: '1309', name: 'TV & Film' },
  { genreId: '1314', name: 'Religion & Spirituality' },
  { genreId: '1502', name: 'Leisure' }
]

export function podcastCategoryName(genreId: string): string | null {
  return PODCAST_BROWSE_CATEGORIES.find((c) => c.genreId === genreId)?.name ?? null
}

export interface BrowsePodcastCategoryQuery {
  genreId: string
}

export interface BrowsePodcastCategoryResult {
  hits: PodcastCatalogHit[]
}

/** Progress for a single episode download. */
export interface EpisodeDownloadProgress {
  episodeId: number
  podcastId: number
  status: EpisodeDownloadStatus
  /** 0–1 when known; null when the host omitted Content-Length. */
  fraction: number | null
}

/**
 * Metadata the R1 admission guard needs before fetching episode bytes.
 * Parallel to `TrackAudioMetadata`, without ReplayGain (feeds rarely carry it).
 */
export interface EpisodeAudioMetadata {
  episodeId: number
  durationSec: number | null
  encodedBytes: number
  sampleRateHz: number | null
  channels: number | null
  bitDepth: number | null
  codec: string | null
}

/**
 * Playback identity for a downloaded episode inside the track-id-shaped
 * AudioEngine boundary.
 *
 * Library track ids are positive. Episode playback uses the negation so the
 * existing `load(trackId)` / `oscine://` resolver seam can carry both without
 * colliding with `tracks.id`.
 */
export function episodePlaybackTrackId(episodeId: number): number {
  if (!Number.isInteger(episodeId) || episodeId <= 0) {
    throw new RangeError('episodeId must be a positive integer')
  }
  return -episodeId
}

export function episodeIdFromPlaybackTrackId(trackId: number): number | null {
  if (!Number.isInteger(trackId) || trackId >= 0) return null
  return -trackId
}
