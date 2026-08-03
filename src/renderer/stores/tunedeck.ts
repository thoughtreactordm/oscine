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
import { usePlaybackStore } from '@renderer/stores/playback'
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
 *
 * The one thing here that is not the operator's own state is `showing`, which
 * folds in whether there is a track to describe at all. It is in the store
 * rather than in the frame because three places need the same answer — the
 * frame, the transport's button and `deckData`'s fetch gate — and a rule
 * restated three times is a rule that will be true in two of them.
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
   * Whether the deck is on screen, which is not the same question as `open`.
   *
   * Every surface in the deck is a readout on a track — who made it, what the
   * file is, what else is like it, what played before it. With the transport
   * empty there is no subject, and the deck is four tabs of "Nothing playing"
   * occupying a third of the window. So it stands down until there is something
   * to describe.
   *
   * A derived flag rather than a write to `open`, and that distinction is the
   * whole design: `open` is the operator's standing preference and it is
   * persisted. Forcing it false when the queue drains would mean the deck did
   * not come back when the next track started, and the operator would find a
   * layout they built quietly dismantled by the end of an album.
   *
   * `usePlaybackStore()` inside the getter rather than beside it, for the reason
   * `panes.ts` states at length: this module is imported while the app is being
   * constructed and the getter runs long after. It also keeps the deck from
   * being the thing that instantiates the audio engines.
   */
  const showing = computed(() => open.value && usePlaybackStore().hasTrack)

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
   * The deck leaving the screen stops main fetching for it — **D14**'s drawer
   * scoping.
   *
   * Watched here rather than hooked to `close()`, because `close()` is not the
   * only way the deck goes: the toggle in the transport bar, a direct write to
   * the persisted key and the transport running dry all go around it, and a
   * cancellation that four of five paths perform is one that leaks.
   *
   * On `showing` rather than `open` for that last path. A track ending mid
   * biography-fetch takes the deck off screen, and a lookup that outlives the
   * surface it was for is exactly what D14 says must not happen — the operator
   * consented to fetching for a drawer they had open, not to a request that
   * finishes into nothing.
   *
   * Only on the true→false edge, so the flag arriving as `false` from the view
   * store during hydration does not send a cancel for a deck that was never
   * open. Failures are logged and swallowed: cancelling is an optimisation —
   * nothing is waiting on the reply, and main abandons the work when the window
   * goes anyway.
   */
  watch(showing, (isShowing, wasShowing) => {
    if (wasShowing === true && !isShowing) {
      void net.cancelScope('tunedeck').catch((err: unknown) => {
        console.warn('[tunedeck] could not cancel in-flight lookups:', err)
      })
    }
  })

  /**
   * Flips the standing preference, and declines while there is nothing to show.
   *
   * The transport's button is disabled in that state, so this guard is for the
   * paths that are not a click — and for the one that would be worst if it were
   * missing: a toggle that silently set `open` while the deck was suppressed
   * would leave the operator's preference inverted, and the deck would appear
   * *because* they asked for it to go away, one track later.
   */
  function toggle(): void {
    if (!open.value && !usePlaybackStore().hasTrack) return
    open.value = !open.value
  }

  function close(): void {
    open.value = false
  }

  return {
    open,
    showing,
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
