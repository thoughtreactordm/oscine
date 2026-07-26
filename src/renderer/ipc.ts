import { FermataError, type IpcResult } from '@shared/errors'
import type { ListTracksQuery, ScanProgress } from '@shared/library'

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
  listTracks: (query: ListTracksQuery) => unwrap(window.fermata.library.listTracks(query)),
  getTrackFileUrl: (trackId: number) => unwrap(window.fermata.library.getTrackFileUrl(trackId)),
  /** Returns an unsubscribe function. Call it on unmount. */
  onScanProgress: (listener: (progress: ScanProgress) => void) =>
    window.fermata.library.onScanProgress(listener)
}

export const versions = (): typeof window.fermata.versions => window.fermata.versions

export { FermataError } from '@shared/errors'
export type { IpcErrorCode } from '@shared/errors'
