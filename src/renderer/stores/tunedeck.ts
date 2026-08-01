import { defineStore } from 'pinia'
import { TUNEDECK_OPEN_KEY, TUNEDECK_PANE } from '@renderer/panels/tunedeck/tunedeckPanes'
import { useViewSettings } from '@renderer/settings'
import { useShellStore } from '@renderer/stores/shell'

/**
 * Whether the deck is showing, and how wide.
 *
 * A store rather than state in `AppShell`, for the reason the cover toggle is:
 * the gesture that opens the deck is made in the transport bar and the deck is
 * mounted by the frame, and neither may import the other. `NowPlaying` flips a
 * flag here; the frame reads it. That is the whole coupling, and it is the same
 * shape a dock host would need.
 *
 * A store rather than component state, too, because the deck outlives every tab
 * — a route change unmounts the body underneath it, and a deck that closed
 * because the operator looked at Curate would be the mounting lifecycle showing
 * through the UI again.
 *
 * Both values are persisted, and neither is persisted here: `open` is one
 * view-scoped key and `width` is one entry in the shared pane-size record. This
 * store is where they are named together, not where they are kept.
 */
export const useTunedeckStore = defineStore('tunedeck', () => {
  const open = useViewSettings().value<boolean>(TUNEDECK_OPEN_KEY)

  /**
   * Through the shell store, like the Sources split's, rather than a second
   * layout instance of its own. `view.shellPaneSizes` is one record keyed by
   * `PaneSpec.key`, and two writers spreading their own copy of it is how one
   * pane's drag ends up discarding another's.
   */
  const width = useShellStore().paneSize(TUNEDECK_PANE)

  function toggle(): void {
    open.value = !open.value
  }

  function close(): void {
    open.value = false
  }

  return { open, width, toggle, close }
})
