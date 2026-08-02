import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResult } from '@shared/errors'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcRequest,
  IpcResponse
} from '@shared/ipc'
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
  AddTracksToPlaylistRequest,
  ExportPlaylistRequest,
  ListPlaylistEntriesQuery,
  ListPlaylistEntryGroupsQuery,
  ListPlaylistEntryIdsQuery,
  MovePlaylistEntriesRequest,
  RemovePlaylistEntriesRequest
} from '@shared/playlists'
import type {
  BrowsePodcastCategoryQuery,
  EpisodeDownloadProgress,
  ListEpisodesQuery,
  ListRecentEpisodesQuery,
  SearchPodcastCatalogQuery
} from '@shared/podcasts'
import type {
  GetSettingOverridesRequest,
  ImportSettingsProfileRequest,
  ResetSettingsRequest,
  SetSettingRequest,
  SettingsChange
} from '@shared/settings'

/**
 * The entire main/renderer seam.
 *
 * `request` and `subscribe` below are module-private and stay that way.
 * Exposing a generic `invoke(channel, ...args)` would hand the renderer every
 * channel main will ever register, including ones added years from now by
 * someone who never read this file. Only the named operations in `api` are
 * published.
 *
 * Note that these return the `IpcResult` envelope rather than throwing on
 * failure. That is deliberate, and was measured rather than assumed: an error
 * thrown inside a `contextBridge` function is flattened as it crosses into the
 * main world — the subclass and every custom property are stripped, leaving a
 * plain `Error` with only `message`. The renderer would have been left
 * string-matching messages to tell "no such track" from "disk unreadable".
 * Data survives the crossing intact, so the envelope crosses and
 * `src/renderer/ipc.ts` rebuilds a real `FermataError` on the far side.
 */

function request<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>
): Promise<IpcResult<IpcResponse<C>>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<IpcResponse<C>>>
}

/** Returns an unsubscribe function; callers must call it on unmount. */
function subscribe<E extends IpcEventChannel>(
  channel: E,
  listener: (payload: IpcEventPayload<E>) => void
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: IpcEventPayload<E>): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.off(channel, wrapped)
  }
}

const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  windowControls: {
    minimize: () => request('window.minimize', null),
    toggleMaximize: () => request('window.toggleMaximize', null),
    isMaximized: () => request('window.isMaximized', null),
    close: () => request('window.close', null),
    onMaximizedChange: (listener: (maximized: boolean) => void) =>
      subscribe('window.maximizedChange', listener)
  },
  library: {
    /** Opens a native folder picker in main. Resolves `null` if cancelled. */
    addRoot: () => request('library.addRoot', null),
    listRoots: () => request('library.listRoots', null),
    scanRoot: (rootId: number) => request('library.scanRoot', { rootId }),
    listArtists: (query: ListFacetsQuery) => request('library.listArtists', query),
    listAlbums: (query: ListFacetsQuery) => request('library.listAlbums', query),
    /** The same two windows, ids only — for range selection and pruning. */
    listArtistIds: (query: ListFacetIdsQuery) => request('library.listArtistIds', query),
    listAlbumIds: (query: ListFacetIdsQuery) => request('library.listAlbumIds', query),
    listTracks: (query: ListTracksQuery) => request('library.listTracks', query),
    /** The same window as `listTracks`, ids only — for range selection. */
    listTrackIds: (query: ListTrackIdsQuery) => request('library.listTrackIds', query),
    listTrackGroups: (query: ListTrackGroupsQuery) => request('library.listTrackGroups', query),
    /** Orders an arbitrary id set the way the track list would. */
    orderTrackIds: (query: OrderTrackIdsQuery) => request('library.orderTrackIds', query),
    /** Display rows for an id list the caller already ordered. */
    getTracksByIds: (query: GetTracksByIdsQuery) => request('library.getTracksByIds', query),
    /** Metadata-only lookup for the audio admission guard. */
    getTrackAudioMetadata: (trackId: number) =>
      request('library.getTrackAudioMetadata', { trackId }),
    /** On-demand format block for the signal readout. Re-parsed, not indexed. */
    getTrackFormatDetail: (trackId: number) => request('library.getTrackFormatDetail', { trackId }),
    /** Opaque `fermata://` URL for the track's bytes. Never a filesystem path. */
    getTrackFileUrl: (trackId: number) => request('library.getTrackFileUrl', { trackId }),
    startReplayGain: () => request('library.startReplayGain', null),
    getReplayGainJob: () => request('library.getReplayGainJob', null),
    cancelReplayGain: (jobId: number) => request('library.cancelReplayGain', { jobId }),
    resumeReplayGain: (jobId: number) => request('library.resumeReplayGain', { jobId }),
    onScanProgress: (listener: (progress: ScanProgress) => void) =>
      subscribe('library.scanProgress', listener),
    onNotice: (listener: (notice: LibraryNotice) => void) => subscribe('library.notice', listener),
    onReplayGainProgress: (listener: (progress: ReplayGainJobProgress) => void) =>
      subscribe('library.replayGainProgress', listener)
  },
  history: {
    /** One play, at the moment the transport committed to it. Main stamps the time. */
    record: (trackId: number) => request('history.record', { trackId }),
    /** The trail, most recent first. Bounded by `PLAY_HISTORY_CAP`. */
    list: (limit: number) => request('history.list', { limit }),
    clear: () => request('history.clear', null)
  },
  playlists: {
    /** Every playlist, in tab order. */
    list: () => request('playlists.list', null),
    create: (name: string) => request('playlists.create', { name }),
    rename: (playlistId: number, name: string) => request('playlists.rename', { playlistId, name }),
    /** Cascades to the playlist's entries. The tracks themselves are untouched. */
    delete: (playlistId: number) => request('playlists.delete', { playlistId }),
    reorder: (playlistId: number, toIndex: number) =>
      request('playlists.reorder', { playlistId, toIndex }),
    listEntries: (query: ListPlaylistEntriesQuery) => request('playlists.listEntries', query),
    /** The same window, ids only — for range selection in the contents pane. */
    listEntryIds: (query: ListPlaylistEntryIdsQuery) => request('playlists.listEntryIds', query),
    /** The album runs of a playlist, for the contents pane's headers. */
    listEntryGroups: (query: ListPlaylistEntryGroupsQuery) =>
      request('playlists.listEntryGroups', query),
    /** A whole multi-selection in one call, however large. */
    addTracks: (payload: AddTracksToPlaylistRequest) => request('playlists.addTracks', payload),
    moveEntries: (payload: MovePlaylistEntriesRequest) => request('playlists.moveEntries', payload),
    removeEntries: (payload: RemovePlaylistEntriesRequest) =>
      request('playlists.removeEntries', payload),
    /** Opens a native save dialog in main. Resolves `null` if cancelled. */
    exportM3u8: (payload: ExportPlaylistRequest) => request('playlists.exportM3u8', payload)
  },
  podcasts: {
    list: () => request('podcasts.list', null),
    get: (podcastId: number) => request('podcasts.get', { podcastId }),
    subscribe: (feedUrl: string) => request('podcasts.subscribe', { feedUrl }),
    unsubscribe: (podcastId: number) => request('podcasts.unsubscribe', { podcastId }),
    refresh: (podcastId: number) => request('podcasts.refresh', { podcastId }),
    refreshAll: () => request('podcasts.refreshAll', null),
    listEpisodes: (query: ListEpisodesQuery) => request('podcasts.listEpisodes', query),
    listRecent: (query: ListRecentEpisodesQuery) => request('podcasts.listRecent', query),
    downloadEpisode: (episodeId: number) => request('podcasts.downloadEpisode', { episodeId }),
    deleteDownload: (episodeId: number) => request('podcasts.deleteDownload', { episodeId }),
    clearDownloads: (podcastId: number) => request('podcasts.clearDownloads', { podcastId }),
    setPlayed: (episodeId: number, played: boolean) =>
      request('podcasts.setPlayed', { episodeId, played }),
    importOpml: (xml: string) => request('podcasts.importOpml', { xml }),
    getEpisodeFileUrl: (episodeId: number) => request('podcasts.getEpisodeFileUrl', { episodeId }),
    getEpisodeAudioMetadata: (episodeId: number) =>
      request('podcasts.getEpisodeAudioMetadata', { episodeId }),
    searchCatalog: (query: SearchPodcastCatalogQuery) => request('podcasts.searchCatalog', query),
    recommend: () => request('podcasts.recommend', null),
    browseCategory: (query: BrowsePodcastCategoryQuery) =>
      request('podcasts.browseCategory', query),
    onDownloadProgress: (listener: (progress: EpisodeDownloadProgress) => void) =>
      subscribe('podcasts.downloadProgress', listener)
  },
  settings: {
    /** Every durable key resolved, with whatever did not survive the load. */
    getAll: () => request('settings.getAll', null),
    /** Revalidated in main; the response carries what was actually stored. */
    /** One entity's override rows, for a renderer resolving its own cascade. */
    getOverrides: (payload: GetSettingOverridesRequest) =>
      request('settings.getOverrides', payload),
    set: (payload: SetSettingRequest) => request('settings.set', payload),
    /** One key, one category, or every durable key. */
    reset: (payload: ResetSettingsRequest) => request('settings.reset', payload),
    /** Save dialog, then the portable keys as JSON. `null` when cancelled. */
    exportProfile: () => request('settings.exportProfile', null),
    /** Open dialog, then a parsed profile. Nothing is applied. */
    readProfile: () => request('settings.readProfile', null),
    /** Applies one, and answers with the plan main actually carried out. */
    importProfile: (payload: ImportSettingsProfileRequest) =>
      request('settings.importProfile', payload),
    onChanged: (listener: (changes: SettingsChange[]) => void) =>
      subscribe('settings.changed', listener)
  }
} as const

export type FermataApi = typeof api

contextBridge.exposeInMainWorld('fermata', api)
