import { contextBridge } from 'electron'

/**
 * The entire main/renderer seam. W1-3 replaces this placeholder with the typed
 * channel map from `src/shared`.
 *
 * The rule this file exists to enforce: only named operations are ever exposed.
 * A generic `invoke(channel, ...args)` passthrough would hand the renderer the
 * whole main process and quietly undo context isolation.
 */
const api = {
  /** Build/runtime versions, useful for the About surface and bug reports. */
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
} as const

export type FermataApi = typeof api

contextBridge.exposeInMainWorld('fermata', api)
