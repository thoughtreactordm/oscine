import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'
import { useViewSettings } from '@renderer/settings'
import {
  createScrollMemory,
  createShellLayout,
  tabDirection,
  type TabDirection
} from '@renderer/shell/shellLayout'

/**
 * Shell chrome state: what the frame is showing and what shape it is in, as
 * opposed to what the library or the transport is doing.
 *
 * A store rather than a prop chain because the two ends of the cover toggle are
 * islands that must not know each other. `NowPlaying` owns a thumbnail that
 * flips a flag; `Sources` owns a slot that reads it. Neither imports the other,
 * so docking either one elsewhere later changes nothing here.
 *
 * A store rather than component state for the rest of it because a tab *is* a
 * route, and a route change unmounts everything under it. Pane sizes and scroll
 * offsets outlive any one tab by definition — the user did not undo their
 * layout by going to look at Now Playing — so they cannot live anywhere the
 * mounting lifecycle can reach them.
 *
 * Thin on purpose. The behaviour is in `shell/shellLayout.ts`, which knows
 * nothing of Pinia or of storage; this is the one place the real view store is
 * bolted on, exactly as `trackColumns` does it.
 */
const COVER_EXPANDED_KEY = 'view.coverExpanded'

export const useShellStore = defineStore('shell', () => {
  const settings = useViewSettings()
  const layout = createShellLayout({ settings })
  const scroll = createScrollMemory()

  /**
   * Whether the sidebar is showing the full-size cover below its facets.
   *
   * Persisted so the operator finds the cover where they left it on restart.
   */
  const coverExpanded: Ref<boolean> = settings.value<boolean>(COVER_EXPANDED_KEY)

  function toggleCover(): void {
    coverExpanded.value = !coverExpanded.value
  }

  function collapseCover(): void {
    coverExpanded.value = false
  }

  /**
   * Which tab is showing, mirrored from the route.
   *
   * The route stays the source of truth for *navigation* — it is what survives
   * a reload and what a deep link addresses — and this is what the frame
   * renders from. The index is kept alongside the name because it is the only
   * thing that can say which way the row moved: a name on its own cannot tell
   * the body whether Curate is to the left or the right of where the user was.
   */
  const activeTab = ref<string | null>(null)
  const activeTabIndex = ref(-1)
  const direction = ref<TabDirection>('none')

  /**
   * The view to fall back to when Now Playing bows out on its own — G2.
   *
   * The most recent tab that was not Now Playing itself, which is precisely
   * "where the user came from" for the visit to Now Playing that follows it. A
   * queue that plays through returns the frame here rather than stranding the
   * user on a stage with nothing on it. Seeded at the launch tab so the fall
   * back is defined before any navigation has happened.
   */
  const returnView = ref<string>('library')

  function setActiveTab(name: string | null, index: number): void {
    if (name === activeTab.value && index === activeTabIndex.value) return
    direction.value = tabDirection(activeTabIndex.value, index)
    activeTab.value = name
    activeTabIndex.value = index
    // Recorded on the way *to* a view rather than on the way out of Now
    // Playing, so the value is already right the moment Now Playing is entered
    // — there is no leaving event to hang it on, and a deep link or a shortcut
    // can reach Now Playing without one.
    if (name !== null && name !== 'now-playing') returnView.value = name
  }

  /**
   * A standing request from the chrome to reveal the Quick Menu.
   *
   * The View menu can ask for the Quick Menu from anywhere, but the drawer lives
   * inside Now Playing and only exists while that tab is on screen — so the menu
   * navigates there and leaves this flag set rather than reaching into a
   * component that may not be mounted yet. `QuickMenu` clears it the moment it
   * sees it, whether it was already mounted (a watcher fires) or is arriving on
   * the navigation the menu just triggered (it reads the flag on mount). A flag
   * rather than an event so the second case cannot miss a signal sent before it
   * existed.
   */
  const quickMenuRequested = ref(false)

  function requestQuickMenu(): void {
    quickMenuRequested.value = true
  }

  function consumeQuickMenuRequest(): boolean {
    if (!quickMenuRequested.value) return false
    quickMenuRequested.value = false
    return true
  }

  return {
    ...layout,
    coverExpanded,
    toggleCover,
    collapseCover,
    activeTab,
    activeTabIndex,
    direction,
    returnView,
    setActiveTab,
    quickMenuRequested,
    requestQuickMenu,
    consumeQuickMenuRequest,
    rememberScroll: scroll.remember,
    recallScroll: scroll.recall,
    forgetScroll: scroll.forget
  }
})
