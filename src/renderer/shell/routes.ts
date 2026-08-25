import type { Component } from 'vue'
import type { RouteLocationRaw, RouteRecordRaw } from 'vue-router'
import AppShell from '@renderer/shell/AppShell.vue'
import SettingsRail from '@renderer/panels/settings/SettingsRail.vue'
import Sources from '@renderer/panels/Sources.vue'
import CurateSidebar from '@renderer/views/CurateSidebar.vue'
import CurateView from '@renderer/views/CurateView.vue'
import LibraryView from '@renderer/views/LibraryView.vue'
import PodcastsSidebar from '@renderer/views/PodcastsSidebar.vue'
import PodcastsView from '@renderer/views/PodcastsView.vue'
import SettingsView from '@renderer/views/SettingsView.vue'
import StageView from '@renderer/views/StageView.vue'
import StatsView from '@renderer/views/StatsView.vue'

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
  /**
   * Whether the tab sits in the trailing group of the row, pushed to the right
   * and separated from the primary navigation. Stats and Settings are utilities
   * about the library rather than places within it, so they read as a distinct
   * cluster (G1). Everything else defaults to the leading group.
   */
  trailing?: boolean
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
    icon: 'i-tabler-playlist',
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
  },
  /**
   * The Stats dashboard — W10-12's "top-level destination", which is a tab.
   *
   * No sidebar, like Now Playing: its one control is a range that scopes the
   * whole view, which belongs in a row above the content rather than in a rail
   * beside it, and four ranked lists and a chart want the width.
   *
   * Trailing, with Settings: both are utilities about the library rather than
   * places within it, so they cluster to the right of the primary tabs (G1).
   */
  {
    name: 'stats',
    path: 'stats',
    label: 'Stats',
    icon: 'i-tabler-chart-histogram',
    view: StatsView,
    trailing: true
  },
  {
    name: 'settings',
    path: 'settings',
    label: 'Settings',
    icon: 'i-tabler-settings',
    view: SettingsView,
    sidebar: SettingsRail,
    trailing: true
  }
]

/**
 * Where a link to one setting goes.
 *
 * The deep-link addressing, in the one file that already knows what a route is
 * called. W8-8's inline controls each carry a way through to the full view, and
 * the alternative — every panel with a gear on it hand-building `{ name:
 * 'settings', query: { key } }` — is the same route name written down a dozen
 * times, which is how a rename becomes a hunt.
 */
export function settingsRouteFor(key: string): RouteLocationRaw {
  return { name: 'settings', query: { key } }
}

/** What the tab row needs, without handing it the components. */
export const shellTabs = TABS.map(({ name, label, icon, trailing }) => ({
  name,
  label,
  icon,
  trailing: Boolean(trailing)
}))

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
