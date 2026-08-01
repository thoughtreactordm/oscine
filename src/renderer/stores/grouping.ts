import { defineStore } from 'pinia'
import { createGroupingPreference } from '@renderer/panels/groupingLayout'
import { useViewSettings } from '@renderer/settings'

/**
 * Whether the song list groups by album, and how large the sleeves are.
 *
 * A store rather than component state because it outlives the panel and because
 * two places read it: `TrackList` draws against it, and `trackList` uses it to
 * decide whether to ask main for the runs at all. As elsewhere, the behaviour
 * lives in the plain module and this is the one place the view store is
 * attached.
 */
export const useTrackGroupingStore = defineStore('trackGrouping', () =>
  createGroupingPreference({ settings: useViewSettings() })
)
