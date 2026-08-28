import { OscineError, type IpcResult } from '@shared/errors'
import type {
  ListFacetIdsQuery,
  ListFacetsQuery,
  ListTagFacetsQuery,
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
import type { WritebackProgress, WritebackSelection } from '@shared/tagWriteback'
import type { OverrideField, OverridePatch } from '@shared/overrides'
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
  /** The unified genre/tag browse vocabulary under the current predicate (W15-5). */
  listTagFacets: (query: ListTagFacetsQuery) => unwrap(window.oscine.library.listTagFacets(query)),
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
  /** The album and album-artist a track sits in — the Tags pane's batch scope. */
  trackFacets: (trackId: number) => unwrap(window.oscine.library.trackFacets(trackId)),
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

/**
 * Track-metadata editing — **W16 (editor)**. Corrections land in
 * `track_overrides` and materialise into the live rows; no file is touched.
 */
export const overrides = {
  /** The editor's prefill for a set of tracks. */
  getEditState: (trackIds: readonly number[]) =>
    unwrap(window.oscine.overrides.getEditState(trackIds)),
  /** Apply a metadata edit to a batch. */
  set: (trackIds: readonly number[], patch: OverridePatch) =>
    unwrap(window.oscine.overrides.set(trackIds, patch)),
  /** Revert the named fields on a batch to what the files hold. */
  clear: (trackIds: readonly number[], fields: readonly OverrideField[]) =>
    unwrap(window.oscine.overrides.clear(trackIds, fields)),
  /** Discard every pending edit — revert the whole correction layer to the files. */
  discardAll: () => unwrap(window.oscine.overrides.discardAll())
}

/**
 * Staged tag write-back review — **W16-6**. Scope in and report out are track
 * ids and typed codes; this half of the boundary never sees a path.
 */
export const tagWriteback = {
  /** The pending writes worth reviewing for a set of tracks — changed only. */
  preview: (trackIds: readonly number[]) => unwrap(window.oscine.tagWriteback.preview(trackIds)),
  /** Every track with an unwritten correction — the review's default set. */
  pending: () => unwrap(window.oscine.tagWriteback.pending()),
  /** Flush the reviewed batch; subscribe to `onApplyProgress` for live progress. */
  apply: (selections: readonly WritebackSelection[]) =>
    unwrap(window.oscine.tagWriteback.apply(selections)),
  /** Stop the running flush between files. The awaited `apply` resolves cancelled. */
  cancelApply: () => unwrap(window.oscine.tagWriteback.cancelApply()),
  /** Returns an unsubscribe function. Call it on unmount. */
  onApplyProgress: (listener: (progress: WritebackProgress) => void) =>
    window.oscine.tagWriteback.onApplyProgress(listener)
}

/**
 * Cover ingest — **W16-10**. Image bytes only ever travel renderer→main; every
 * result is an {@link ArtworkRef} the renderer re-addresses through `oscine://`,
 * never the bytes themselves.
 */
export const artwork = {
  /** Open the OS image picker in main and set the chosen cover on a batch. */
  setFromDialog: (trackIds: readonly number[]) =>
    unwrap(window.oscine.artwork.setFromDialog(trackIds)),
  /** Ship a dropped/pasted image's bytes one way to main and set it on a batch. */
  setFromBytes: (trackIds: readonly number[], bytes: Uint8Array, mime: string) =>
    unwrap(window.oscine.artwork.setFromBytes(trackIds, bytes, mime)),
  /** Set the tri-state clear (cover removed on flush) on a batch. */
  clear: (trackIds: readonly number[]) => unwrap(window.oscine.artwork.clear(trackIds)),
  /** Drop the override on a batch — back to the file's own cover. */
  revert: (trackIds: readonly number[]) => unwrap(window.oscine.artwork.revert(trackIds))
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

export const tags = {
  /** The tag vocabulary with a live per-tag count — the browse column's whole content. */
  list: () => unwrap(window.oscine.tags.list()),
  /** One track's two vocabularies, file genres and user tags kept apart. */
  forTrack: (trackId: number) => unwrap(window.oscine.tags.forTrack(trackId)),
  /** The two vocabularies for a batch of tracks — the Genre/Tags column's read (W15-5). */
  forTracks: (trackIds: readonly number[]) => unwrap(window.oscine.tags.forTracks(trackIds)),
  /** An artist's tags as coverage over its catalogue, carried/total. */
  forArtist: (artistId: number) => unwrap(window.oscine.tags.forArtist(artistId)),
  /** Applies one label to a batch, coining it if new. Answers with the vocabulary row. */
  add: (trackIds: readonly number[], label: string) =>
    unwrap(window.oscine.tags.add(trackIds, label)),
  /** Removes one tag from a batch; prunes it if that emptied it. */
  remove: (trackIds: readonly number[], tagId: number) =>
    unwrap(window.oscine.tags.remove(trackIds, tagId)),
  /** Re-spells one tag — correction, rename, or merge. Answers with the surviving row. */
  rename: (tagId: number, label: string) => unwrap(window.oscine.tags.rename(tagId, label)),
  /** Tags the operator might want. Empty until the MusicBrainz card lands. */
  suggest: (trackId: number) => unwrap(window.oscine.tags.suggest(trackId))
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
  image: (artistId: number) => unwrap(window.oscine.artists.image(artistId)),
  links: (artistId: number) => unwrap(window.oscine.artists.links(artistId))
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
