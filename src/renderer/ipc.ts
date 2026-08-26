import { OscineError, type IpcResult } from '@shared/errors'
import type {
  ListFacetIdsQuery,
  ListFacetsQuery,
  ListTrackGroupsQuery,
  GetTracksByIdsQuery,
  ListTrackIdsQuery,
  ListTracksQuery,
  LibraryNotice,
  OrderTrackIdsQuery,
  ReplayGainJobProgress,
  ScanProgress
} from '@shared/library'
import type {
  ListFavoriteArtistsQuery,
  ListFavoriteIdsQuery,
  ListFavoritePlaylistsQuery,
  ListFavoritesQuery
} from '@shared/favorites'
import type { RecordListenRequest } from '@shared/listens'
import type { StatsOverTimeQuery, StatsQuery, StatsSummaryQuery } from '@shared/stats'
import type { NetScope } from '@shared/net'
import type { ScrobbleTargetId, ScrobbleTargetStatus } from '@shared/scrobble'
import type { DiscoverRecipeId } from '@shared/discover'
import type { SearchQuery } from '@shared/search'
import type {
  AddTracksToPlaylistRequest,
  ExportPlaylistRequest,
  ListPlaylistEntriesQuery,
  ListPlaylistEntryGroupsQuery,
  ListPlaylistEntryIdsQuery,
  MovePlaylistEntriesRequest,
  RemovePlaylistEntriesRequest
} from '@shared/playlists'
import type {
  GetSettingOverridesRequest,
  ImportSettingsProfileRequest,
  ResetSettingsRequest,
  SetSettingRequest,
  SettingsChange
} from '@shared/settings'
import type {
  BrowsePodcastCategoryQuery,
  EpisodeDownloadProgress,
  ListEpisodesQuery,
  ListRecentEpisodesQuery,
  SearchPodcastCatalogQuery
} from '@shared/podcasts'

/**
 * The renderer's view of the IPC boundary.
 *
 * The preload bridge returns `IpcResult` envelopes because a thrown error loses
 * its type as it crosses `contextBridge` — the subclass and every custom
 * property are stripped, leaving a bare `Error` with only a message. This
 * module runs in the renderer's own world, so the `OscineError` it constructs
 * keeps its `code` and callers can branch on the failure instead of
 * string-matching the message.
 *
 * Renderer code should import from here, not reach for `window.oscine`.
 */

async function unwrap<T>(pending: Promise<IpcResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) {
    throw new OscineError(result.error.code, result.error.message)
  }
  return result.value
}

export const library = {
  addRoot: () => unwrap(window.oscine.library.addRoot()),
  listRoots: () => unwrap(window.oscine.library.listRoots()),
  scanRoot: (rootId: number) => unwrap(window.oscine.library.scanRoot(rootId)),
  /** Forgets a folder and answers with the roots left. Never touches disk. */
  removeRoot: (rootId: number) => unwrap(window.oscine.library.removeRoot(rootId)),
  listArtists: (query: ListFacetsQuery) => unwrap(window.oscine.library.listArtists(query)),
  listAlbums: (query: ListFacetsQuery) => unwrap(window.oscine.library.listAlbums(query)),
  listArtistIds: (query: ListFacetIdsQuery) => unwrap(window.oscine.library.listArtistIds(query)),
  listAlbumIds: (query: ListFacetIdsQuery) => unwrap(window.oscine.library.listAlbumIds(query)),
  /** The Quick Menu's Recent Additions — albums by arrival, newest first (D25/D26). */
  recentlyAddedAlbums: (limit: number) => unwrap(window.oscine.library.recentlyAddedAlbums(limit)),
  listTracks: (query: ListTracksQuery) => unwrap(window.oscine.library.listTracks(query)),
  listTrackIds: (query: ListTrackIdsQuery) => unwrap(window.oscine.library.listTrackIds(query)),
  listTrackGroups: (query: ListTrackGroupsQuery) =>
    unwrap(window.oscine.library.listTrackGroups(query)),
  orderTrackIds: (query: OrderTrackIdsQuery) => unwrap(window.oscine.library.orderTrackIds(query)),
  getTracksByIds: (query: GetTracksByIdsQuery) =>
    unwrap(window.oscine.library.getTracksByIds(query)),
  /** Catalog and neighbourhood relations for one track. Local index only. */
  getRelated: (trackId: number) => unwrap(window.oscine.library.getRelated(trackId)),
  getTrackAudioMetadata: (trackId: number) =>
    unwrap(window.oscine.library.getTrackAudioMetadata(trackId)),
  getTrackFormatDetail: (trackId: number) =>
    unwrap(window.oscine.library.getTrackFormatDetail(trackId)),
  getTrackFileUrl: (trackId: number) => unwrap(window.oscine.library.getTrackFileUrl(trackId)),
  startReplayGain: () => unwrap(window.oscine.library.startReplayGain()),
  getReplayGainJob: () => unwrap(window.oscine.library.getReplayGainJob()),
  cancelReplayGain: (jobId: number) => unwrap(window.oscine.library.cancelReplayGain(jobId)),
  resumeReplayGain: (jobId: number) => unwrap(window.oscine.library.resumeReplayGain(jobId)),
  /** Returns an unsubscribe function. Call it on unmount. */
  onScanProgress: (listener: (progress: ScanProgress) => void) =>
    window.oscine.library.onScanProgress(listener),
  onNotice: (listener: (notice: LibraryNotice) => void) => window.oscine.library.onNotice(listener),
  onReplayGainProgress: (listener: (progress: ReplayGainJobProgress) => void) =>
    window.oscine.library.onReplayGainProgress(listener)
}

export const history = {
  record: (trackId: number) => unwrap(window.oscine.history.record(trackId)),
  list: (limit: number) => unwrap(window.oscine.history.list(limit)),
  clear: () => unwrap(window.oscine.history.clear())
}

export const listens = {
  record: (entry: RecordListenRequest) => unwrap(window.oscine.listens.record(entry)),
  flushed: () => unwrap(window.oscine.listens.flushed()),
  /** Returns an unsubscribe function. Call it on unmount. */
  onFlushRequested: (listener: () => void) => window.oscine.listens.onFlushRequested(listener)
}

export const stats = {
  rebuildCounters: () => unwrap(window.oscine.stats.rebuildCounters()),
  /**
   * One ranking. The presets are resolved here, into `{ from, to }` — main has
   * no timezone and no calendar, which is what keeps "this year" honest.
   */
  query: (query: StatsQuery) => unwrap(window.oscine.stats.query(query)),
  /**
   * The headline numbers over the same resolved range, for the whole log or for
   * one group around a track — the dashboard's channel and the Tunedeck's.
   */
  summary: (query: StatsSummaryQuery) => unwrap(window.oscine.stats.summary(query)),
  /** The bucketed series. Buckets anchor at `range.from` — send local midnight. */
  overTime: (query: StatsOverTimeQuery) => unwrap(window.oscine.stats.overTime(query))
}

export const favorites = {
  /** Flips one track's heart. Answers with the state that resulted, never a guess. */
  toggle: (trackId: number) => unwrap(window.oscine.favorites.toggle(trackId)),
  /** Which of these track ids are favorited — for ids that did not arrive on a `Track`. */
  state: (trackIds: readonly number[]) => unwrap(window.oscine.favorites.state(trackIds)),
  list: (query: ListFavoritesQuery) => unwrap(window.oscine.favorites.list(query)),
  /** The same window, ids only — a Shift-range, or the whole collection to play. */
  listIds: (query: ListFavoriteIdsQuery) => unwrap(window.oscine.favorites.listIds(query)),
  /** The playing artist's favorites — the deck's pane, seeded by track, all local. */
  byArtist: (trackId: number) => unwrap(window.oscine.favorites.byArtist(trackId)),
  /** Un-favorites a batch. Removing a row from the pinned rail entry is this. */
  remove: (trackIds: readonly number[]) => unwrap(window.oscine.favorites.remove(trackIds)),
  /** Flips a playlist's star, answering with the favorited subset it touched — D24. */
  togglePlaylist: (playlistId: number) =>
    unwrap(window.oscine.favorites.togglePlaylist(playlistId)),
  /** Which of these playlists are starred — the batch a playlist surface hydrates through. */
  playlistState: (playlistIds: readonly number[]) =>
    unwrap(window.oscine.favorites.playlistState(playlistIds)),
  /** The artist star, mirroring `togglePlaylist` — D24. */
  toggleArtist: (artistId: number) => unwrap(window.oscine.favorites.toggleArtist(artistId)),
  /** Which of these artists are starred — the batch an artist surface hydrates through. */
  artistState: (artistIds: readonly number[]) =>
    unwrap(window.oscine.favorites.artistState(artistIds)),
  /** The Quick Menu's Favorite Playlists — starred playlists, newest first, capped (D26). */
  listPlaylists: (query: ListFavoritePlaylistsQuery) =>
    unwrap(window.oscine.favorites.listPlaylists(query)),
  /** The Quick Menu's Favorite Artists — the real starred artists, capped (D26). */
  listArtists: (query: ListFavoriteArtistsQuery) =>
    unwrap(window.oscine.favorites.listArtists(query))
}

export const playlists = {
  list: () => unwrap(window.oscine.playlists.list()),
  create: (name: string) => unwrap(window.oscine.playlists.create(name)),
  rename: (playlistId: number, name: string) =>
    unwrap(window.oscine.playlists.rename(playlistId, name)),
  delete: (playlistId: number) => unwrap(window.oscine.playlists.delete(playlistId)),
  reorder: (playlistId: number, toIndex: number) =>
    unwrap(window.oscine.playlists.reorder(playlistId, toIndex)),
  listEntries: (query: ListPlaylistEntriesQuery) =>
    unwrap(window.oscine.playlists.listEntries(query)),
  listEntryIds: (query: ListPlaylistEntryIdsQuery) =>
    unwrap(window.oscine.playlists.listEntryIds(query)),
  listEntryGroups: (query: ListPlaylistEntryGroupsQuery) =>
    unwrap(window.oscine.playlists.listEntryGroups(query)),
  addTracks: (payload: AddTracksToPlaylistRequest) =>
    unwrap(window.oscine.playlists.addTracks(payload)),
  moveEntries: (payload: MovePlaylistEntriesRequest) =>
    unwrap(window.oscine.playlists.moveEntries(payload)),
  removeEntries: (payload: RemovePlaylistEntriesRequest) =>
    unwrap(window.oscine.playlists.removeEntries(payload)),
  /** Resolves `null` when the operator dismisses the save dialog. */
  exportM3u8: (payload: ExportPlaylistRequest) =>
    unwrap(window.oscine.playlists.exportM3u8(payload))
}

/**
 * Unified search — the command palette's data side (D23). One channel, grouped
 * and ranked in main. The renderer parses the prefix into a `SearchMode` first;
 * `action` and `setting` modes resolve in the renderer and never call this.
 */
export const search = {
  query: (query: SearchQuery) => unwrap(window.oscine.search.query(query))
}

/**
 * Music Discover. Recipes run in main; the renderer asks for today's page and
 * can snapshot one shelf as a playlist. Playing is not here.
 */
export const discover = {
  shelves: () => unwrap(window.oscine.discover.shelves()),
  saveShelf: (recipeId: DiscoverRecipeId) => unwrap(window.oscine.discover.saveShelf(recipeId))
}

export const podcasts = {
  list: () => unwrap(window.oscine.podcasts.list()),
  get: (podcastId: number) => unwrap(window.oscine.podcasts.get(podcastId)),
  subscribe: (feedUrl: string) => unwrap(window.oscine.podcasts.subscribe(feedUrl)),
  unsubscribe: (podcastId: number) => unwrap(window.oscine.podcasts.unsubscribe(podcastId)),
  refresh: (podcastId: number) => unwrap(window.oscine.podcasts.refresh(podcastId)),
  refreshAll: () => unwrap(window.oscine.podcasts.refreshAll()),
  listEpisodes: (query: ListEpisodesQuery) => unwrap(window.oscine.podcasts.listEpisodes(query)),
  listRecent: (query: ListRecentEpisodesQuery) => unwrap(window.oscine.podcasts.listRecent(query)),
  downloadEpisode: (episodeId: number) => unwrap(window.oscine.podcasts.downloadEpisode(episodeId)),
  cancelDownload: (episodeId: number) => unwrap(window.oscine.podcasts.cancelDownload(episodeId)),
  deleteDownload: (episodeId: number) => unwrap(window.oscine.podcasts.deleteDownload(episodeId)),
  clearDownloads: (podcastId: number) => unwrap(window.oscine.podcasts.clearDownloads(podcastId)),
  setPlayed: (episodeId: number, played: boolean) =>
    unwrap(window.oscine.podcasts.setPlayed(episodeId, played)),
  setAutoDownload: (podcastId: number, enabled: boolean) =>
    unwrap(window.oscine.podcasts.setAutoDownload(podcastId, enabled)),
  setKeepLast: (podcastId: number, keepLast: number) =>
    unwrap(window.oscine.podcasts.setKeepLast(podcastId, keepLast)),
  importOpml: (xml: string) => unwrap(window.oscine.podcasts.importOpml(xml)),
  getEpisodeFileUrl: (episodeId: number) =>
    unwrap(window.oscine.podcasts.getEpisodeFileUrl(episodeId)),
  getEpisodeAudioMetadata: (episodeId: number) =>
    unwrap(window.oscine.podcasts.getEpisodeAudioMetadata(episodeId)),
  searchCatalog: (query: SearchPodcastCatalogQuery) =>
    unwrap(window.oscine.podcasts.searchCatalog(query)),
  recommend: () => unwrap(window.oscine.podcasts.recommend()),
  browseCategory: (query: BrowsePodcastCategoryQuery) =>
    unwrap(window.oscine.podcasts.browseCategory(query)),
  onDownloadProgress: (listener: (progress: EpisodeDownloadProgress) => void) =>
    window.oscine.podcasts.onDownloadProgress(listener)
}

/**
 * The durable half of the settings surface.
 *
 * Shaped as `DurableSettingsBridge` so `createSettingsStore` takes it whole —
 * the store is written against this contract rather than against `window`, which
 * is what lets it be driven by a fake under the node test config.
 */
export const settings = {
  getAll: () => unwrap(window.oscine.settings.getAll()),
  getOverrides: (payload: GetSettingOverridesRequest) =>
    unwrap(window.oscine.settings.getOverrides(payload)),
  set: (payload: SetSettingRequest) => unwrap(window.oscine.settings.set(payload)),
  reset: (payload: ResetSettingsRequest) => unwrap(window.oscine.settings.reset(payload)),
  exportProfile: () => unwrap(window.oscine.settings.exportProfile()),
  readProfile: () => unwrap(window.oscine.settings.readProfile()),
  importProfile: (payload: ImportSettingsProfileRequest) =>
    unwrap(window.oscine.settings.importProfile(payload)),
  /** Returns an unsubscribe function. Call it on unmount. */
  onChanged: (listener: (changes: SettingsChange[]) => void) =>
    window.oscine.settings.onChanged(listener)
}

/**
 * The renderer's half of D14: it can stop main fetching, and cannot start it.
 *
 * Deliberately not shaped like the other bridges. There is no `get` here and
 * there will not be one — the lookups W7-9 adds answer through their own
 * channels, so this stays the one call whose job is to say "nobody is looking
 * any more".
 */
export const net = {
  cancelScope: (scope: NetScope) => unwrap(window.oscine.net.cancelScope(scope))
}

/**
 * Scrobbling accounts and the outbox's health — **D19**'s renderer half.
 *
 * `connect` is the one call in this file that can sit unresolved for minutes: it
 * resolves when the operator has finished in their own browser, and the pane's
 * waiting state is exactly the lifetime of that promise. It rejects only for the
 * reasons any channel does; the ordinary failures — no application key, no
 * keyring, a tab closed — arrive as a failed `NetResult` to be *shown*.
 */
export const scrobble = {
  status: () => unwrap(window.oscine.scrobble.status()),
  connect: (target: ScrobbleTargetId) => unwrap(window.oscine.scrobble.connect(target)),
  cancelConnect: (target: ScrobbleTargetId) => unwrap(window.oscine.scrobble.cancelConnect(target)),
  disconnect: (target: ScrobbleTargetId) => unwrap(window.oscine.scrobble.disconnect(target)),
  retry: () => unwrap(window.oscine.scrobble.retry()),
  /** Returns an unsubscribe function. Call it on unmount. */
  onStatusChanged: (listener: (targets: ScrobbleTargetStatus[]) => void) =>
    window.oscine.scrobble.onStatusChanged(listener)
}

/**
 * **R5**: the artist tag resolved to an identity, and the operator's veto over it.
 *
 * Every call here can cause main to fetch, which is why every one of them is
 * made from the deck and nowhere else — D14 scopes lookups to an open drawer,
 * and a store elsewhere in the app calling `resolve` on a track change would
 * defeat that from the other side of the boundary.
 */
export const artists = {
  resolve: (trackId: number) => unwrap(window.oscine.artists.resolve(trackId)),
  searchCandidates: (artistId: number) => unwrap(window.oscine.artists.searchCandidates(artistId)),
  setMbid: (artistId: number, mbid: string | null) =>
    unwrap(window.oscine.artists.setMbid(artistId, mbid)),
  clearMbid: (artistId: number) => unwrap(window.oscine.artists.clearMbid(artistId)),
  biography: (artistId: number) => unwrap(window.oscine.artists.biography(artistId)),
  relations: (artistId: number) => unwrap(window.oscine.artists.relations(artistId)),
  image: (artistId: number) => unwrap(window.oscine.artists.image(artistId))
}

export const windowControls = {
  minimize: () => unwrap(window.oscine.windowControls.minimize()),
  toggleMaximize: () => unwrap(window.oscine.windowControls.toggleMaximize()),
  isMaximized: () => unwrap(window.oscine.windowControls.isMaximized()),
  close: () => unwrap(window.oscine.windowControls.close()),
  onMaximizedChange: (listener: (maximized: boolean) => void) =>
    window.oscine.windowControls.onMaximizedChange(listener)
}

export const appInfo = {
  getVersion: () => unwrap(window.oscine.appInfo.getVersion()),
  /** Opens an http/https link in the system browser; main refuses the rest. */
  openExternal: (url: string) => unwrap(window.oscine.appInfo.openExternal(url))
}

export const versions = (): typeof window.oscine.versions => window.oscine.versions

export { OscineError } from '@shared/errors'
export type { IpcErrorCode } from '@shared/errors'
