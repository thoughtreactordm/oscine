import { defineStore } from 'pinia'
import { createColumnLayout } from '@renderer/panels/columnLayout'
import { useViewSettings } from '@renderer/settings'

/**
 * The track list's persisted column layout.
 *
 * A store rather than component state because the layout outlives the panel —
 * it has to be the same after a restart, and M4's playlist views will read the
 * same one. As with `trackList`, all of the behaviour lives in the plain module
 * and this is the single place the real view store is bolted on, which is what
 * lets the rules be tested without a DOM.
 */
export const useTrackColumnsStore = defineStore('trackColumns', () =>
  createColumnLayout({ settings: useViewSettings() })
)
