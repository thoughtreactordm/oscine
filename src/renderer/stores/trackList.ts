import { defineStore } from 'pinia'
import { library } from '@renderer/ipc'
import { createTrackWindow } from '@renderer/panels/trackWindow'

/**
 * Panel state for the track list: sort column, direction, selection, and the
 * window of rows currently held.
 *
 * The store is deliberately thin. All of the behaviour lives in
 * `createTrackWindow`, which knows nothing about Pinia or IPC; this is the one
 * place the real `library.listTracks` is bolted on. That split is what lets the
 * windowing be tested against a synthetic 100k-row source without an Electron
 * process anywhere in sight.
 */
export const useTrackListStore = defineStore('trackList', () =>
  createTrackWindow({ fetchPage: (query) => library.listTracks(query) })
)
