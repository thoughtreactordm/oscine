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
  ListPlaylistEntryIdsQuery,
  MovePlaylistEntriesRequest,
  RemovePlaylistEntriesRequest
} from '@shared/playlists'

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
    /** Metadata-only lookup for the audio admission guard. */
    getTrackAudioMetadata: (trackId: number) =>
      request('library.getTrackAudioMetadata', { trackId }),
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
  playlists: {
    /** Every playlist, in tab order. */
    list: () => request('playlists.list', null),
    /** `crossfadeMs` omitted means gapless — R2's zero. */
    create: (name: string, crossfadeMs?: number) =>
      request('playlists.create', { name, crossfadeMs }),
    rename: (playlistId: number, name: string) => request('playlists.rename', { playlistId, name }),
    setCrossfade: (playlistId: number, crossfadeMs: number) =>
      request('playlists.setCrossfade', { playlistId, crossfadeMs }),
    /** Cascades to the playlist's entries. The tracks themselves are untouched. */
    delete: (playlistId: number) => request('playlists.delete', { playlistId }),
    reorder: (playlistId: number, toIndex: number) =>
      request('playlists.reorder', { playlistId, toIndex }),
    listEntries: (query: ListPlaylistEntriesQuery) => request('playlists.listEntries', query),
    /** The same window, ids only — for range selection in the contents pane. */
    listEntryIds: (query: ListPlaylistEntryIdsQuery) => request('playlists.listEntryIds', query),
    /** A whole multi-selection in one call, however large. */
    addTracks: (payload: AddTracksToPlaylistRequest) => request('playlists.addTracks', payload),
    moveEntries: (payload: MovePlaylistEntriesRequest) => request('playlists.moveEntries', payload),
    removeEntries: (payload: RemovePlaylistEntriesRequest) =>
      request('playlists.removeEntries', payload),
    /** Opens a native save dialog in main. Resolves `null` if cancelled. */
    exportM3u8: (payload: ExportPlaylistRequest) => request('playlists.exportM3u8', payload)
  }
} as const

export type FermataApi = typeof api

contextBridge.exposeInMainWorld('fermata', api)
