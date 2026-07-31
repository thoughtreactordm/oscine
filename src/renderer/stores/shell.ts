import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  browserShellLayoutStorage,
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
 * nothing of Pinia or `localStorage`; this is the one place the real storage is
 * bolted on, exactly as `trackColumns` does it.
 */
export const useShellStore = defineStore('shell', () => {
  const layout = createShellLayout({ storage: browserShellLayoutStorage() })
  const scroll = createScrollMemory()

  /**
   * Whether the sidebar is showing the full-size cover below its facets.
   *
   * Deliberately outside the persisted layout, where the pane sizes now live:
   * an expanded cover is a glance rather than a layout the user built, and it
   * is the one piece of frame state that should start closed every session.
   */
  const coverExpanded = ref(false)

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

  function setActiveTab(name: string | null, index: number): void {
    if (name === activeTab.value && index === activeTabIndex.value) return
    direction.value = tabDirection(activeTabIndex.value, index)
    activeTab.value = name
    activeTabIndex.value = index
  }

  return {
    ...layout,
    coverExpanded,
    toggleCover,
    collapseCover,
    activeTab,
    activeTabIndex,
    direction,
    setActiveTab,
    rememberScroll: scroll.remember,
    recallScroll: scroll.recall,
    forgetScroll: scroll.forget
  }
})
