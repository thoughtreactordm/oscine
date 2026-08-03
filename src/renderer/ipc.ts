import { FermataError, type IpcResult } from '@shared/errors'
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
import type { RecordListenRequest } from '@shared/listens'
import type { NetScope } from '@shared/net'
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
 * module runs in the renderer's own world, so the `FermataError` it constructs
 * keeps its `code` and callers can branch on the failure instead of
 * string-matching the message.
 *
 * Renderer code should import from here, not reach for `window.fermata`.
 */

async function unwrap<T>(pending: Promise<IpcResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) {
    throw new FermataError(result.error.code, result.error.message)
  }
  return result.value
}

export const library = {
  addRoot: () => unwrap(window.fermata.library.addRoot()),
  listRoots: () => unwrap(window.fermata.library.listRoots()),
  scanRoot: (rootId: number) => unwrap(window.fermata.library.scanRoot(rootId)),
  /** Forgets a folder and answers with the roots left. Never touches disk. */
  removeRoot: (rootId: number) => unwrap(window.fermata.library.removeRoot(rootId)),
  listArtists: (query: ListFacetsQuery) => unwrap(window.fermata.library.listArtists(query)),
  listAlbums: (query: ListFacetsQuery) => unwrap(window.fermata.library.listAlbums(query)),
  listArtistIds: (query: ListFacetIdsQuery) => unwrap(window.fermata.library.listArtistIds(query)),
  listAlbumIds: (query: ListFacetIdsQuery) => unwrap(window.fermata.library.listAlbumIds(query)),
  listTracks: (query: ListTracksQuery) => unwrap(window.fermata.library.listTracks(query)),
  listTrackIds: (query: ListTrackIdsQuery) => unwrap(window.fermata.library.listTrackIds(query)),
  listTrackGroups: (query: ListTrackGroupsQuery) =>
    unwrap(window.fermata.library.listTrackGroups(query)),
  orderTrackIds: (query: OrderTrackIdsQuery) => unwrap(window.fermata.library.orderTrackIds(query)),
  getTracksByIds: (query: GetTracksByIdsQuery) =>
    unwrap(window.fermata.library.getTracksByIds(query)),
  /** Catalog and neighbourhood relations for one track. Local index only. */
  getRelated: (trackId: number) => unwrap(window.fermata.library.getRelated(trackId)),
  getTrackAudioMetadata: (trackId: number) =>
    unwrap(window.fermata.library.getTrackAudioMetadata(trackId)),
  getTrackFormatDetail: (trackId: number) =>
    unwrap(window.fermata.library.getTrackFormatDetail(trackId)),
  getTrackFileUrl: (trackId: number) => unwrap(window.fermata.library.getTrackFileUrl(trackId)),
  startReplayGain: () => unwrap(window.fermata.library.startReplayGain()),
  getReplayGainJob: () => unwrap(window.fermata.library.getReplayGainJob()),
  cancelReplayGain: (jobId: number) => unwrap(window.fermata.library.cancelReplayGain(jobId)),
  resumeReplayGain: (jobId: number) => unwrap(window.fermata.library.resumeReplayGain(jobId)),
  /** Returns an unsubscribe function. Call it on unmount. */
  onScanProgress: (listener: (progress: ScanProgress) => void) =>
    window.fermata.library.onScanProgress(listener),
  onNotice: (listener: (notice: LibraryNotice) => void) =>
    window.fermata.library.onNotice(listener),
  onReplayGainProgress: (listener: (progress: ReplayGainJobProgress) => void) =>
    window.fermata.library.onReplayGainProgress(listener)
}

export const history = {
  record: (trackId: number) => unwrap(window.fermata.history.record(trackId)),
  list: (limit: number) => unwrap(window.fermata.history.list(limit)),
  clear: () => unwrap(window.fermata.history.clear())
}

export const listens = {
  record: (entry: RecordListenRequest) => unwrap(window.fermata.listens.record(entry)),
  flushed: () => unwrap(window.fermata.listens.flushed()),
  /** Returns an unsubscribe function. Call it on unmount. */
  onFlushRequested: (listener: () => void) => window.fermata.listens.onFlushRequested(listener)
}

export const playlists = {
  list: () => unwrap(window.fermata.playlists.list()),
  create: (name: string) => unwrap(window.fermata.playlists.create(name)),
  rename: (playlistId: number, name: string) =>
    unwrap(window.fermata.playlists.rename(playlistId, name)),
  delete: (playlistId: number) => unwrap(window.fermata.playlists.delete(playlistId)),
  reorder: (playlistId: number, toIndex: number) =>
    unwrap(window.fermata.playlists.reorder(playlistId, toIndex)),
  listEntries: (query: ListPlaylistEntriesQuery) =>
    unwrap(window.fermata.playlists.listEntries(query)),
  listEntryIds: (query: ListPlaylistEntryIdsQuery) =>
    unwrap(window.fermata.playlists.listEntryIds(query)),
  listEntryGroups: (query: ListPlaylistEntryGroupsQuery) =>
    unwrap(window.fermata.playlists.listEntryGroups(query)),
  addTracks: (payload: AddTracksToPlaylistRequest) =>
    unwrap(window.fermata.playlists.addTracks(payload)),
  moveEntries: (payload: MovePlaylistEntriesRequest) =>
    unwrap(window.fermata.playlists.moveEntries(payload)),
  removeEntries: (payload: RemovePlaylistEntriesRequest) =>
    unwrap(window.fermata.playlists.removeEntries(payload)),
  /** Resolves `null` when the operator dismisses the save dialog. */
  exportM3u8: (payload: ExportPlaylistRequest) =>
    unwrap(window.fermata.playlists.exportM3u8(payload))
}

export const podcasts = {
  list: () => unwrap(window.fermata.podcasts.list()),
  get: (podcastId: number) => unwrap(window.fermata.podcasts.get(podcastId)),
  subscribe: (feedUrl: string) => unwrap(window.fermata.podcasts.subscribe(feedUrl)),
  unsubscribe: (podcastId: number) => unwrap(window.fermata.podcasts.unsubscribe(podcastId)),
  refresh: (podcastId: number) => unwrap(window.fermata.podcasts.refresh(podcastId)),
  refreshAll: () => unwrap(window.fermata.podcasts.refreshAll()),
  listEpisodes: (query: ListEpisodesQuery) => unwrap(window.fermata.podcasts.listEpisodes(query)),
  listRecent: (query: ListRecentEpisodesQuery) => unwrap(window.fermata.podcasts.listRecent(query)),
  downloadEpisode: (episodeId: number) =>
    unwrap(window.fermata.podcasts.downloadEpisode(episodeId)),
  deleteDownload: (episodeId: number) => unwrap(window.fermata.podcasts.deleteDownload(episodeId)),
  clearDownloads: (podcastId: number) => unwrap(window.fermata.podcasts.clearDownloads(podcastId)),
  setPlayed: (episodeId: number, played: boolean) =>
    unwrap(window.fermata.podcasts.setPlayed(episodeId, played)),
  importOpml: (xml: string) => unwrap(window.fermata.podcasts.importOpml(xml)),
  getEpisodeFileUrl: (episodeId: number) =>
    unwrap(window.fermata.podcasts.getEpisodeFileUrl(episodeId)),
  getEpisodeAudioMetadata: (episodeId: number) =>
    unwrap(window.fermata.podcasts.getEpisodeAudioMetadata(episodeId)),
  searchCatalog: (query: SearchPodcastCatalogQuery) =>
    unwrap(window.fermata.podcasts.searchCatalog(query)),
  recommend: () => unwrap(window.fermata.podcasts.recommend()),
  browseCategory: (query: BrowsePodcastCategoryQuery) =>
    unwrap(window.fermata.podcasts.browseCategory(query)),
  onDownloadProgress: (listener: (progress: EpisodeDownloadProgress) => void) =>
    window.fermata.podcasts.onDownloadProgress(listener)
}

/**
 * The durable half of the settings surface.
 *
 * Shaped as `DurableSettingsBridge` so `createSettingsStore` takes it whole —
 * the store is written against this contract rather than against `window`, which
 * is what lets it be driven by a fake under the node test config.
 */
export const settings = {
  getAll: () => unwrap(window.fermata.settings.getAll()),
  getOverrides: (payload: GetSettingOverridesRequest) =>
    unwrap(window.fermata.settings.getOverrides(payload)),
  set: (payload: SetSettingRequest) => unwrap(window.fermata.settings.set(payload)),
  reset: (payload: ResetSettingsRequest) => unwrap(window.fermata.settings.reset(payload)),
  exportProfile: () => unwrap(window.fermata.settings.exportProfile()),
  readProfile: () => unwrap(window.fermata.settings.readProfile()),
  importProfile: (payload: ImportSettingsProfileRequest) =>
    unwrap(window.fermata.settings.importProfile(payload)),
  /** Returns an unsubscribe function. Call it on unmount. */
  onChanged: (listener: (changes: SettingsChange[]) => void) =>
    window.fermata.settings.onChanged(listener)
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
  cancelScope: (scope: NetScope) => unwrap(window.fermata.net.cancelScope(scope))
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
  resolve: (trackId: number) => unwrap(window.fermata.artists.resolve(trackId)),
  searchCandidates: (artistId: number) => unwrap(window.fermata.artists.searchCandidates(artistId)),
  setMbid: (artistId: number, mbid: string | null) =>
    unwrap(window.fermata.artists.setMbid(artistId, mbid)),
  clearMbid: (artistId: number) => unwrap(window.fermata.artists.clearMbid(artistId)),
  biography: (artistId: number) => unwrap(window.fermata.artists.biography(artistId)),
  relations: (artistId: number) => unwrap(window.fermata.artists.relations(artistId)),
  image: (artistId: number) => unwrap(window.fermata.artists.image(artistId))
}

export const windowControls = {
  minimize: () => unwrap(window.fermata.windowControls.minimize()),
  toggleMaximize: () => unwrap(window.fermata.windowControls.toggleMaximize()),
  isMaximized: () => unwrap(window.fermata.windowControls.isMaximized()),
  close: () => unwrap(window.fermata.windowControls.close()),
  onMaximizedChange: (listener: (maximized: boolean) => void) =>
    window.fermata.windowControls.onMaximizedChange(listener)
}

export const versions = (): typeof window.fermata.versions => window.fermata.versions

export { FermataError } from '@shared/errors'
export type { IpcErrorCode } from '@shared/errors'
