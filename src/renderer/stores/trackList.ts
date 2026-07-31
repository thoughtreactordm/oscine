import { defineStore } from 'pinia'
import { watch } from 'vue'
import { library } from '@renderer/ipc'
import { measureLibraryQuery } from '@renderer/metrics'
import { createTrackWindow } from '@renderer/panels/trackWindow'
import { useTrackGroupingStore } from '@renderer/stores/grouping'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'

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
export const useTrackListStore = defineStore('trackList', () => {
  const grouping = useTrackGroupingStore()
  const roots = useLibraryRootsStore()

  const panel = createTrackWindow({
    fetchPage: (query) => measureLibraryQuery('tracks-query', () => library.listTracks(query)),
    fetchIdPage: (query) =>
      measureLibraryQuery('track-ids-query', () => library.listTrackIds(query)),
    orderIds: (query) => measureLibraryQuery('order-ids-query', () => library.orderTrackIds(query)),
    /**
     * Not asked for while grouping is off.
     *
     * A library of eight thousand albums is eight thousand rows across IPC for a
     * header nobody is drawing, and the window has no way to know that itself.
     */
    fetchGroups: (query) =>
      grouping.enabled
        ? measureLibraryQuery('track-groups-query', () => library.listTrackGroups(query))
        : Promise.resolve({ groups: [], total: 0 })
  })

  // Switching grouping back on has to fetch what was skipped, but the rows have
  // not moved, so this refreshes the runs rather than reloading the list.
  watch(() => grouping.enabled, panel.refreshGroups)

  // A finished scan has moved the rows themselves. Watched here rather than
  // signalled by the sidebar, because a scan started from the title bar has to
  // reach the list whichever tab was showing when it finished.
  watch(() => roots.version, panel.reload)

  return panel
})
