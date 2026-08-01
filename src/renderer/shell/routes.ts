import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import AppShell from '@renderer/shell/AppShell.vue'
import Sources from '@renderer/panels/Sources.vue'
import CurateSidebar from '@renderer/views/CurateSidebar.vue'
import CurateView from '@renderer/views/CurateView.vue'
import LibraryView from '@renderer/views/LibraryView.vue'
import PodcastsSidebar from '@renderer/views/PodcastsSidebar.vue'
import PodcastsView from '@renderer/views/PodcastsView.vue'
import StageView from '@renderer/views/StageView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    /**
     * Whether the frame draws its sidebar for this tab — and with it the cover
     * pane, which belongs to the sidebar container rather than to any tab.
     */
    sidebar: boolean
  }
}

/**
 * One tab, in one place.
 *
 * The tab row and the router would otherwise be two lists that have to agree
 * about what tabs exist. They are one list here: the row is rendered from
 * `shellTabs` and the routes are generated from the same array, so adding a tab
 * is adding an entry and nothing else.
 */
interface ShellTab {
  /** Route name, and the identity the tab row switches on. */
  name: string
  /** Path under the shell layout. The first tab is the index route. */
  path: string
  label: string
  icon: string
  /** The tab's body, mounted in the frame's main region. */
  view: Component
  /**
   * What the tab puts in the sidebar, above the cover pane. Omitted for tabs
   * that want the full width — the frame drops the whole sidebar for those.
   */
  sidebar?: Component
}

const TABS: ShellTab[] = [
  {
    name: 'library',
    path: '',
    label: 'Library',
    icon: 'i-tabler-library',
    view: LibraryView,
    sidebar: Sources
  },
  {
    name: 'curate',
    path: 'curate',
    label: 'Curate',
    icon: 'i-tabler-sparkles',
    view: CurateView,
    sidebar: CurateSidebar
  },
  {
    name: 'podcasts',
    path: 'podcasts',
    label: 'Podcasts',
    icon: 'i-tabler-microphone',
    view: PodcastsView,
    sidebar: PodcastsSidebar
  },
  {
    name: 'now-playing',
    path: 'now-playing',
    label: 'Now Playing',
    icon: 'i-tabler-disc',
    view: StageView
  }
]

/** What the tab row needs, without handing it the components. */
export const shellTabs = TABS.map(({ name, label, icon }) => ({ name, label, icon }))

export const shellRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AppShell,
    children: TABS.map((tab): RouteRecordRaw => {
      const components: Record<string, Component> = { default: tab.view }
      if (tab.sidebar) components.sidebar = tab.sidebar
      return {
        path: tab.path,
        name: tab.name,
        components,
        meta: { sidebar: Boolean(tab.sidebar) }
      }
    })
  }
]
