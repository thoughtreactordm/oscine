import type Database from 'better-sqlite3'
import { artworkUrl } from '@shared/ipc'
import {
  DEFAULT_KEEP_LAST,
  type Episode,
  type EpisodeDownloadStatus,
  type ListEpisodesQuery,
  type ListEpisodesResult,
  type ListRecentEpisodesQuery,
  type ListRecentEpisodesResult,
  type Podcast
} from '@shared/podcasts'
import type { ParsedFeed, ParsedFeedEpisode } from './rss'

interface PodcastRow {
  id: number
  feed_url: string
  title: string
  author: string | null
  description: string | null
  site_url: string | null
  artwork_hash: string | null
  subscribed_at: number
  last_fetched_at: number | null
  last_error: string | null
  auto_download: number
  keep_last: number
  episode_count: number
  undownloaded_count: number
  unplayed_count: number
}

interface EpisodeRow {
  id: number
  podcast_id: number
  guid: string
  title: string
  description: string | null
  pub_date: number | null
  duration_ms: number | null
  enclosure_url: string
  rel_path: string | null
  downloaded_at: number | null
  file_size: number | null
  download_error: string | null
  played: number
  progress_ms: number
  podcast_title: string
  podcast_artwork_hash: string | null
}

export interface EpisodePathRow {
  id: number
  rel_path: string | null
  file_size: number | null
  duration_ms: number | null
  enclosure_url: string
  download_error: string | null
}

export class PodcastStore {
  constructor(private readonly db: Database.Database) {}

  listPodcasts(): Podcast[] {
    const rows = this.db
      .prepare(
        `
SELECT
  p.id, p.feed_url, p.title, p.author, p.description, p.site_url, p.artwork_hash,
  p.subscribed_at, p.last_fetched_at, p.last_error, p.auto_download, p.keep_last,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id) AS episode_count,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.rel_path IS NULL) AS undownloaded_count,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.played = 0) AS unplayed_count
FROM podcasts p
ORDER BY p.title COLLATE NOCASE ASC
`
      )
      .all() as PodcastRow[]
    return rows.map(mapPodcast)
  }

  getPodcast(podcastId: number): Podcast | null {
    const row = this.db
      .prepare(
        `
SELECT
  p.id, p.feed_url, p.title, p.author, p.description, p.site_url, p.artwork_hash,
  p.subscribed_at, p.last_fetched_at, p.last_error, p.auto_download, p.keep_last,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id) AS episode_count,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.rel_path IS NULL) AS undownloaded_count,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.played = 0) AS unplayed_count
FROM podcasts p
WHERE p.id = ?
`
      )
      .get(podcastId) as PodcastRow | undefined
    return row ? mapPodcast(row) : null
  }

  findByFeedUrl(feedUrl: string): Podcast | null {
    const row = this.db
      .prepare(
        `
SELECT
  p.id, p.feed_url, p.title, p.author, p.description, p.site_url, p.artwork_hash,
  p.subscribed_at, p.last_fetched_at, p.last_error, p.auto_download, p.keep_last,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id) AS episode_count,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.rel_path IS NULL) AS undownloaded_count,
  (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.played = 0) AS unplayed_count
FROM podcasts p
WHERE p.feed_url = ?
`
      )
      .get(feedUrl) as PodcastRow | undefined
    return row ? mapPodcast(row) : null
  }

  insertPodcast(input: {
    feedUrl: string
    title: string
    author: string | null
    description: string | null
    siteUrl: string | null
    artworkUrl: string | null
    subscribedAt: number
  }): number {
    const result = this.db
      .prepare(
        `
INSERT INTO podcasts (
  feed_url, title, author, description, site_url, artwork_url, subscribed_at, keep_last
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`
      )
      .run(
        input.feedUrl,
        input.title,
        input.author,
        input.description,
        input.siteUrl,
        input.artworkUrl,
        input.subscribedAt,
        DEFAULT_KEEP_LAST
      )
    return Number(result.lastInsertRowid)
  }

  updatePodcastFromFeed(
    podcastId: number,
    feed: ParsedFeed,
    fetchedAt: number,
    artworkHash: string | null
  ): void {
    this.db
      .prepare(
        `
UPDATE podcasts SET
  title = ?,
  author = ?,
  description = ?,
  site_url = ?,
  artwork_url = ?,
  artwork_hash = COALESCE(?, artwork_hash),
  last_fetched_at = ?,
  last_error = NULL
WHERE id = ?
`
      )
      .run(
        feed.title,
        feed.author,
        feed.description,
        feed.siteUrl,
        feed.artworkUrl,
        artworkHash,
        fetchedAt,
        podcastId
      )
  }

  setPodcastError(podcastId: number, message: string): void {
    this.db.prepare(`UPDATE podcasts SET last_error = ? WHERE id = ?`).run(message, podcastId)
  }

  setArtworkHash(podcastId: number, hash: string): void {
    this.db.prepare(`UPDATE podcasts SET artwork_hash = ? WHERE id = ?`).run(hash, podcastId)
  }

  deletePodcast(podcastId: number): void {
    this.db.prepare(`DELETE FROM podcasts WHERE id = ?`).run(podcastId)
  }

  upsertEpisodes(podcastId: number, episodes: readonly ParsedFeedEpisode[]): void {
    const upsert = this.db.prepare(
      `
INSERT INTO episodes (
  podcast_id, guid, title, description, pub_date, duration_ms,
  enclosure_url, enclosure_type, enclosure_size
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(podcast_id, guid) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  pub_date = excluded.pub_date,
  duration_ms = COALESCE(excluded.duration_ms, episodes.duration_ms),
  enclosure_url = excluded.enclosure_url,
  enclosure_type = excluded.enclosure_type,
  enclosure_size = COALESCE(excluded.enclosure_size, episodes.enclosure_size)
`
    )
    const tx = this.db.transaction(() => {
      for (const episode of episodes) {
        upsert.run(
          podcastId,
          episode.guid,
          episode.title,
          episode.description,
          episode.pubDateMs,
          episode.durationMs,
          episode.enclosureUrl,
          episode.enclosureType,
          episode.enclosureSize
        )
      }
    })
    tx()
  }

  listEpisodes(query: ListEpisodesQuery, downloading: ReadonlySet<number>): ListEpisodesResult {
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM episodes WHERE podcast_id = ?`)
        .get(query.podcastId) as { n: number }
    ).n
    const rows = this.db
      .prepare(
        `
SELECT
  e.id, e.podcast_id, e.guid, e.title, e.description, e.pub_date, e.duration_ms,
  e.enclosure_url, e.rel_path, e.downloaded_at, e.file_size, e.download_error,
  e.played, e.progress_ms,
  p.title AS podcast_title, p.artwork_hash AS podcast_artwork_hash
FROM episodes e
JOIN podcasts p ON p.id = e.podcast_id
WHERE e.podcast_id = ?
ORDER BY e.pub_date IS NULL, e.pub_date DESC, e.id DESC
LIMIT ? OFFSET ?
`
      )
      .all(query.podcastId, query.limit, query.offset) as EpisodeRow[]
    return { total, episodes: rows.map((row) => mapEpisode(row, downloading)) }
  }

  listRecent(
    query: ListRecentEpisodesQuery,
    downloading: ReadonlySet<number>
  ): ListRecentEpisodesResult {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n
    const rows = this.db
      .prepare(
        `
SELECT
  e.id, e.podcast_id, e.guid, e.title, e.description, e.pub_date, e.duration_ms,
  e.enclosure_url, e.rel_path, e.downloaded_at, e.file_size, e.download_error,
  e.played, e.progress_ms,
  p.title AS podcast_title, p.artwork_hash AS podcast_artwork_hash
FROM episodes e
JOIN podcasts p ON p.id = e.podcast_id
ORDER BY e.pub_date IS NULL, e.pub_date DESC, e.id DESC
LIMIT ? OFFSET ?
`
      )
      .all(query.limit, query.offset) as EpisodeRow[]
    return { total, episodes: rows.map((row) => mapEpisode(row, downloading)) }
  }

  getEpisode(episodeId: number, downloading: ReadonlySet<number>): Episode | null {
    const row = this.db
      .prepare(
        `
SELECT
  e.id, e.podcast_id, e.guid, e.title, e.description, e.pub_date, e.duration_ms,
  e.enclosure_url, e.rel_path, e.downloaded_at, e.file_size, e.download_error,
  e.played, e.progress_ms,
  p.title AS podcast_title, p.artwork_hash AS podcast_artwork_hash
FROM episodes e
JOIN podcasts p ON p.id = e.podcast_id
WHERE e.id = ?
`
      )
      .get(episodeId) as EpisodeRow | undefined
    return row ? mapEpisode(row, downloading) : null
  }

  getEpisodePath(episodeId: number): EpisodePathRow | null {
    const row = this.db
      .prepare(
        `
SELECT id, rel_path, file_size, duration_ms, enclosure_url, download_error
FROM episodes WHERE id = ?
`
      )
      .get(episodeId) as EpisodePathRow | undefined
    return row ?? null
  }

  getEnclosureUrl(episodeId: number): { enclosureUrl: string; podcastId: number } | null {
    const row = this.db
      .prepare(
        `SELECT enclosure_url AS enclosureUrl, podcast_id AS podcastId FROM episodes WHERE id = ?`
      )
      .get(episodeId) as { enclosureUrl: string; podcastId: number } | undefined
    return row ?? null
  }

  markDownloaded(episodeId: number, relPath: string, fileSize: number, downloadedAt: number): void {
    this.db
      .prepare(
        `
UPDATE episodes SET
  rel_path = ?, file_size = ?, downloaded_at = ?, download_error = NULL
WHERE id = ?
`
      )
      .run(relPath, fileSize, downloadedAt, episodeId)
  }

  markDownloadFailed(episodeId: number, message: string): void {
    this.db.prepare(`UPDATE episodes SET download_error = ? WHERE id = ?`).run(message, episodeId)
  }

  /** Drop local file metadata; the episode row and enclosure URL stay. */
  clearDownload(episodeId: number): void {
    this.db
      .prepare(
        `
UPDATE episodes SET
  rel_path = NULL, file_size = NULL, downloaded_at = NULL, download_error = NULL,
  auto_downloaded = 0
WHERE id = ?
`
      )
      .run(episodeId)
  }

  clearDownloadsForPodcast(podcastId: number): void {
    this.db
      .prepare(
        `
UPDATE episodes SET
  rel_path = NULL, file_size = NULL, downloaded_at = NULL, download_error = NULL,
  auto_downloaded = 0
WHERE podcast_id = ?
`
      )
      .run(podcastId)
  }

  setAutoDownload(podcastId: number, enabled: boolean): void {
    this.db
      .prepare(`UPDATE podcasts SET auto_download = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, podcastId)
  }

  setKeepLast(podcastId: number, keepLast: number): void {
    this.db.prepare(`UPDATE podcasts SET keep_last = ? WHERE id = ?`).run(keepLast, podcastId)
  }

  getKeepLast(podcastId: number): number {
    const row = this.db.prepare(`SELECT keep_last FROM podcasts WHERE id = ?`).get(podcastId) as
      { keep_last: number } | undefined
    return row?.keep_last ?? 0
  }

  /** Flags a downloaded episode as auto-retained (1) or manually kept (0). */
  setAutoDownloaded(episodeId: number, auto: boolean): void {
    this.db
      .prepare(`UPDATE episodes SET auto_downloaded = ? WHERE id = ?`)
      .run(auto ? 1 : 0, episodeId)
  }

  /** The newest `limit` episode ids for a show, newest first. */
  latestEpisodeIds(podcastId: number, limit: number): number[] {
    if (limit <= 0) return []
    const rows = this.db
      .prepare(
        `
SELECT id FROM episodes
WHERE podcast_id = ?
ORDER BY pub_date IS NULL, pub_date DESC, id DESC
LIMIT ?
`
      )
      .all(podcastId, limit) as Array<{ id: number }>
    return rows.map((row) => row.id)
  }

  /**
   * Auto-downloaded, on-disk episode ids ranked past the newest `keepLast` —
   * the prune set. Manual downloads (`auto_downloaded = 0`) are never returned,
   * so pruning cannot touch a file the user kept by hand.
   */
  autoDownloadedBeyond(podcastId: number, keepLast: number): number[] {
    const rows = this.db
      .prepare(
        `
SELECT id FROM episodes
WHERE podcast_id = ? AND auto_downloaded = 1 AND rel_path IS NOT NULL
ORDER BY pub_date IS NULL, pub_date DESC, id DESC
LIMIT -1 OFFSET ?
`
      )
      .all(podcastId, Math.max(0, keepLast)) as Array<{ id: number }>
    return rows.map((row) => row.id)
  }

  setPlayed(episodeId: number, played: boolean): void {
    this.db.prepare(`UPDATE episodes SET played = ? WHERE id = ?`).run(played ? 1 : 0, episodeId)
  }

  setProgress(episodeId: number, progressMs: number): void {
    this.db.prepare(`UPDATE episodes SET progress_ms = ? WHERE id = ?`).run(progressMs, episodeId)
  }

  listEpisodeRelPaths(podcastId: number): string[] {
    const rows = this.db
      .prepare(`SELECT rel_path FROM episodes WHERE podcast_id = ? AND rel_path IS NOT NULL`)
      .all(podcastId) as Array<{ rel_path: string }>
    return rows.map((row) => row.rel_path)
  }

  podcastTitle(podcastId: number): string | null {
    const row = this.db.prepare(`SELECT title FROM podcasts WHERE id = ?`).get(podcastId) as
      { title: string } | undefined
    return row?.title ?? null
  }

  podcastArtworkUrl(podcastId: number): string | null {
    const row = this.db.prepare(`SELECT artwork_url FROM podcasts WHERE id = ?`).get(podcastId) as
      { artwork_url: string | null } | undefined
    return row?.artwork_url ?? null
  }
}

function mapPodcast(row: PodcastRow): Podcast {
  return {
    id: row.id,
    feedUrl: row.feed_url,
    title: row.title,
    author: row.author,
    description: row.description,
    siteUrl: row.site_url,
    artwork: {
      small: artworkUrl(row.artwork_hash, 'small'),
      large: artworkUrl(row.artwork_hash, 'large')
    },
    subscribedAt: new Date(row.subscribed_at).toISOString(),
    lastFetchedAt:
      row.last_fetched_at === null ? null : new Date(row.last_fetched_at).toISOString(),
    lastError: row.last_error,
    episodeCount: row.episode_count,
    undownloadedCount: row.undownloaded_count,
    unplayedCount: row.unplayed_count,
    autoDownload: row.auto_download === 1,
    keepLast: row.keep_last
  }
}

function mapEpisode(row: EpisodeRow, downloading: ReadonlySet<number>): Episode {
  return {
    id: row.id,
    podcastId: row.podcast_id,
    guid: row.guid,
    title: row.title,
    description: row.description,
    pubDate: row.pub_date === null ? null : new Date(row.pub_date).toISOString(),
    durationMs: row.duration_ms,
    downloadStatus: downloadStatus(row, downloading),
    played: row.played === 1,
    progressMs: row.progress_ms,
    podcastTitle: row.podcast_title,
    podcastArtwork: {
      small: artworkUrl(row.podcast_artwork_hash, 'small'),
      large: artworkUrl(row.podcast_artwork_hash, 'large')
    }
  }
}

function downloadStatus(row: EpisodeRow, downloading: ReadonlySet<number>): EpisodeDownloadStatus {
  if (downloading.has(row.id)) return 'downloading'
  if (row.rel_path) return 'ready'
  if (row.download_error) return 'failed'
  return 'remote'
}
