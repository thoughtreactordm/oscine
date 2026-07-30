import { FermataError, type IpcResult } from '@shared/errors'
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
  listArtists: (query: ListFacetsQuery) => unwrap(window.fermata.library.listArtists(query)),
  listAlbums: (query: ListFacetsQuery) => unwrap(window.fermata.library.listAlbums(query)),
  listArtistIds: (query: ListFacetIdsQuery) => unwrap(window.fermata.library.listArtistIds(query)),
  listAlbumIds: (query: ListFacetIdsQuery) => unwrap(window.fermata.library.listAlbumIds(query)),
  listTracks: (query: ListTracksQuery) => unwrap(window.fermata.library.listTracks(query)),
  listTrackIds: (query: ListTrackIdsQuery) => unwrap(window.fermata.library.listTrackIds(query)),
  listTrackGroups: (query: ListTrackGroupsQuery) =>
    unwrap(window.fermata.library.listTrackGroups(query)),
  orderTrackIds: (query: OrderTrackIdsQuery) => unwrap(window.fermata.library.orderTrackIds(query)),
  getTrackAudioMetadata: (trackId: number) =>
    unwrap(window.fermata.library.getTrackAudioMetadata(trackId)),
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
