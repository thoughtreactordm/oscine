import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResult } from '@shared/errors'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcRequest,
  IpcResponse
} from '@shared/ipc'
import type { ListTracksQuery, ScanProgress } from '@shared/library'

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
  library: {
    /** Opens a native folder picker in main. Resolves `null` if cancelled. */
    addRoot: () => request('library.addRoot', null),
    listRoots: () => request('library.listRoots', null),
    scanRoot: (rootId: number) => request('library.scanRoot', { rootId }),
    listTracks: (query: ListTracksQuery) => request('library.listTracks', query),
    /** Opaque `fermata://` URL for the track's bytes. Never a filesystem path. */
    getTrackFileUrl: (trackId: number) => request('library.getTrackFileUrl', { trackId }),
    onScanProgress: (listener: (progress: ScanProgress) => void) =>
      subscribe('library.scanProgress', listener)
  }
} as const

export type FermataApi = typeof api

contextBridge.exposeInMainWorld('fermata', api)
