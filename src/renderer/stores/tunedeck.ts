import { defineStore } from 'pinia'
import { computed, watch } from 'vue'
import { net } from '@renderer/ipc'
import { tunedeckRegistry } from '@renderer/panels/tunedeck/panes'
import {
  isGroupOpen,
  resolveTabId,
  TUNEDECK_GROUPS_KEY,
  TUNEDECK_OPEN_KEY,
  TUNEDECK_PANE,
  TUNEDECK_TAB_KEY,
  type TunedeckTab
} from '@renderer/panels/tunedeck/tunedeckPanes'
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

  /**
   * Which tab is showing, and which groups the operator has collapsed.
   *
   * Both are stored raw and resolved on read rather than validated on write,
   * because the thing that invalidates them is a *build*, not a click: a group
   * renamed or retired between versions leaves a stored id pointing at nothing,
   * and settings written by a newer build can outlive a downgrade. Resolving on
   * read means a stale id costs a fallback rather than a blank deck, and the
   * stale entry is simply overwritten the next time that tab is used.
   *
   * The group record holds what is *shut*, so absent is open — see
   * `isGroupOpen`. A record of what is open would have to name groups that did
   * not exist when it was written for a new group to arrive revealed.
   */
  const storedTab = useViewSettings().value<string>(TUNEDECK_TAB_KEY)
  const storedGroups = useViewSettings().value<Record<string, boolean>>(TUNEDECK_GROUPS_KEY)

  const activeTabId = computed(() => resolveTabId(tunedeckRegistry, storedTab.value))

  const activeTab = computed<TunedeckTab | undefined>(() =>
    tunedeckRegistry.tabById(activeTabId.value)
  )

  /** Whether a group is revealed. Open unless it was shut — see `isGroupOpen`. */
  function groupOpen(groupId: string): boolean {
    return isGroupOpen(storedGroups.value, groupId)
  }

  function selectTab(tabId: string): void {
    storedTab.value = tabId
  }

  /**
   * Reveals or collapses one group, leaving its neighbours where they are.
   *
   * Every group in a tab may be open at once, and every group in a tab may be
   * shut: the chevron a group closes on is the chevron it reopens on, so there
   * is no state this can reach that it cannot obviously leave.
   *
   * Writes a fresh record rather than mutating: the view store's value is
   * compared by reference to decide whether to persist, so an in-place edit is
   * a change that never reaches disk.
   */
  function toggleGroup(groupId: string): void {
    storedGroups.value = { ...storedGroups.value, [groupId]: !groupOpen(groupId) }
  }

  /**
   * Closing the deck stops main fetching for it — **D14**'s drawer scoping.
   *
   * Watched here rather than hooked to `close()`, because `close()` is not the
   * only way the deck shuts: the toggle in the transport bar and a direct write
   * to the persisted key both go around it, and a cancellation that three of
   * four paths perform is one that leaks.
   *
   * Only on the true→false edge, so the flag arriving as `false` from the view
   * store during hydration does not send a cancel for a deck that was never
   * open. Failures are logged and swallowed: cancelling is an optimisation —
   * nothing is waiting on the reply, and main abandons the work when the window
   * goes anyway.
   */
  watch(open, (isOpen, wasOpen) => {
    if (wasOpen === true && !isOpen) {
      void net.cancelScope('tunedeck').catch((err: unknown) => {
        console.warn('[tunedeck] could not cancel in-flight lookups:', err)
      })
    }
  })

  function toggle(): void {
    open.value = !open.value
  }

  function close(): void {
    open.value = false
  }

  return {
    open,
    width,
    activeTabId,
    activeTab,
    groupOpen,
    selectTab,
    toggleGroup,
    toggle,
    close
  }
})
