import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Shell chrome state: what the frame is showing, as opposed to what the library
 * or the transport is doing.
 *
 * A store rather than a prop chain because the two ends of the cover toggle are
 * islands that must not know each other. `NowPlaying` owns a thumbnail that
 * flips a flag; `Sources` owns a slot that reads it. Neither imports the other,
 * so docking either one elsewhere later changes nothing here.
 *
 * Not persisted, matching the dashboard group's `:persistent="false"` — an
 * expanded cover is a glance, not a saved layout.
 */
export const useShellStore = defineStore('shell', () => {
  const bootedAt = ref(new Date().toISOString())

  /** Whether the sidebar is showing the full-size cover below its facets. */
  const coverExpanded = ref(false)

  function toggleCover(): void {
    coverExpanded.value = !coverExpanded.value
  }

  function collapseCover(): void {
    coverExpanded.value = false
  }

  return { bootedAt, coverExpanded, toggleCover, collapseCover }
})
