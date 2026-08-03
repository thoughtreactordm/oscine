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
import type { ListFavoriteIdsQuery, ListFavoritesQuery } from '@shared/favorites'
import type { RecordListenRequest } from '@shared/listens'
import type { StatsOverTimeQuery, StatsQuery, StatsSummaryQuery } from '@shared/stats'
import type { NetScope } from '@shared/net'
import type { ScrobbleConnection, ScrobbleTargetId } from '@shared/scrobble'
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
    /** Forgets a folder and answers with the roots left. Never touches disk. */
    removeRoot: (rootId: number) => request('library.removeRoot', { rootId }),
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
    /** Catalog and neighbourhood relations for one track. Local index only. */
    getRelated: (trackId: number) => request('library.getRelated', { trackId }),
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
  listens: {
    /** One listen, at departure, once it has crossed the threshold. */
    record: (entry: RecordListenRequest) => request('listens.record', entry),
    /** Answers `onFlushRequested`, whether or not there was anything to write. */
    flushed: () => request('listens.flushed', null),
    /** Returns an unsubscribe function. Call it on unmount. */
    onFlushRequested: (listener: () => void) =>
      subscribe('listens.flushRequested', () => {
        listener()
      })
  },
  stats: {
    /**
     * Recomputes `play_count` and `last_played_at` from the log, for every track.
     *
     * The repair, offered on demand. Main runs the same thing itself after a
     * migration that moved `listens`.
     */
    rebuildCounters: () => request('stats.rebuildCounters', null),
    /** One ranking: a range, a dimension, an order, a page. Four dimensions, one call. */
    query: (query: StatsQuery) => request('stats.query', query),
    /** The headline numbers over the same range — the whole log, or one group. */
    summary: (query: StatsSummaryQuery) => request('stats.summary', query),
    /** Listening over time — every bucket in range, including the empty ones. */
    overTime: (query: StatsOverTimeQuery) => request('stats.overTime', query)
  },
  favorites: {
    /** Flips one track's heart. Answers with the state that resulted, never a guess. */
    toggle: (trackId: number) => request('favorites.toggle', { trackId }),
    /**
     * Which of these track ids are favorited.
     *
     * For ids that did not arrive on a `Track`. Anything holding a display row
     * already has `favorite` on it — resolved with the page, which is the whole
     * point — and must not ask this instead.
     */
    state: (trackIds: readonly number[]) => request('favorites.state', { trackIds }),
    /** The favorites, newest-hearted first. Paged like every other list. */
    list: (query: ListFavoritesQuery) => request('favorites.list', query),
    /** The same window, ids only — a Shift-range, or the whole collection to play. */
    listIds: (query: ListFavoriteIdsQuery) => request('favorites.listIds', query),
    /** The playing artist's favorites, seeded by track. Local, and bounded not paged. */
    byArtist: (trackId: number) => request('favorites.byArtist', { trackId }),
    /** Un-favorites a batch. Not a bulk `toggle`: it says which direction it goes. */
    remove: (trackIds: readonly number[]) => request('favorites.remove', { trackIds })
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
  },
  net: {
    /**
     * Abandon main's in-flight and queued work for a scope.
     *
     * There is deliberately nothing here that *starts* a request. D14 puts
     * fetching in main, and the renderer's whole half of that contract is
     * saying when it has stopped caring — see `net.cancelScope` in `ipc.ts`.
     */
    cancelScope: (scope: NetScope) => request('net.cancelScope', { scope })
  },
  /**
   * Scrobbling accounts — **D19**, and a deliberately tiny surface.
   *
   * Four calls, and not one of them can return a credential. The session key is
   * sealed in a main-process file and read only by the target that signs with
   * it; the renderer's entire view is a username and a boolean. That is not a
   * convention this bridge follows carefully — it is the shape of the channels
   * in `ipc.ts`, so there is no careful version of this file that could leak one.
   *
   * There is also nothing here that *sends* a scrobble. Enqueueing happens in
   * main off the listen commit (W11-5), which is what keeps a scrobble a
   * consequence of having listened rather than something a renderer can assert.
   */
  scrobble: {
    /** Every target this build knows, connected or not. */
    connections: () => request('scrobble.connections', null),
    /**
     * Start a sign-in and wait for it.
     *
     * Resolves only when the operator has finished in their browser, given up,
     * or something failed — minutes, potentially. Render a waiting state for the
     * lifetime of this promise and offer `cancelConnect` as the way out.
     */
    connect: (target: ScrobbleTargetId) => request('scrobble.connect', { target }),
    /** Abandon a sign-in in progress. The pending `connect` resolves cancelled. */
    cancelConnect: (target: ScrobbleTargetId) => request('scrobble.cancelConnect', { target }),
    /** Forget the credential. Answers with the connections as they now stand. */
    disconnect: (target: ScrobbleTargetId) => request('scrobble.disconnect', { target }),
    /** Returns an unsubscribe function. Call it on unmount. */
    onConnectionsChanged: (listener: (connections: ScrobbleConnection[]) => void) =>
      subscribe('scrobble.connectionsChanged', listener)
  },
  /**
   * **R5**'s identity surface, and the first thing here that causes a fetch.
   *
   * It is still not the renderer opening a socket: these are requests to main to
   * go and look, which is exactly what D14 puts in main and nowhere else. What
   * the renderer gets back is a resolution — never a URL, never a response body.
   */
  artists: {
    /** Who is playing. `null` when the track carries no artist credit. */
    resolve: (trackId: number) => request('artist.resolve', { trackId }),
    /** The picker's list, fetched because the operator asked to disagree. */
    searchCandidates: (artistId: number) => request('artist.searchCandidates', { artistId }),
    /** The operator's choice. `null` is "none of these", and is durable. */
    setMbid: (artistId: number, mbid: string | null) =>
      request('artist.setMbid', { artistId, mbid }),
    /** Drops the correction; automatic matching resumes immediately. */
    clearMbid: (artistId: number) => request('artist.clearMbid', { artistId }),
    /**
     * The Wikipedia biography, by way of Wikidata.
     *
     * Text, a title and a URL — never the response body, and never markup. The
     * URL is Wikidata's canonical sitelink and exists so the pane can render the
     * link out that CC BY-SA obliges us to.
     */
    biography: (artistId: number) => request('artist.biography', { artistId }),
    /**
     * The MusicBrainz relation graph, already intersected with the library.
     *
     * Names, identifiers and local row ids — never the response body. The
     * intersection happens in main because it needs the `artists` table, which
     * is the same reason the renderer cannot do it: the boundary is where the
     * filesystem stops.
     */
    relations: (artistId: number) => request('artist.relations', { artistId }),
    /**
     * The Commons photograph, by way of Wikidata's image claim.
     *
     * Two `fermata://artwork/…` routes and a credit — never bytes, and never a
     * remote URL to load. The picture is already in the same thumbnail cache
     * album art comes from by the time this resolves, so the renderer loads it
     * from the same privileged scheme and the same handler.
     */
    image: (artistId: number) => request('artist.image', { artistId })
  }
} as const

export type FermataApi = typeof api

contextBridge.exposeInMainWorld('fermata', api)
