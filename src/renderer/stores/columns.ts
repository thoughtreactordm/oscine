import { defineStore } from 'pinia'
import {
  browserLayoutStorage,
  createColumnLayout,
  COLUMN_LAYOUT_STORAGE_KEY
} from '@renderer/panels/columnLayout'

/**
 * The track list's persisted column layout.
 *
 * A store rather than component state because the layout outlives the panel —
 * it has to be the same after a restart, and M4's playlist views will read the
 * same one. As with `trackList`, all of the behaviour lives in the plain module
 * and this is the single place the real storage is bolted on, which is what lets
 * the rules be tested without a DOM or a `localStorage`.
 */
export const useTrackColumnsStore = defineStore('trackColumns', () =>
  createColumnLayout({ storage: browserLayoutStorage(COLUMN_LAYOUT_STORAGE_KEY) })
)
