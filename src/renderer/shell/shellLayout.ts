import { computed, type WritableComputedRef } from 'vue'
import type { ViewSettings } from '../settings/viewStore'
import { clampPaneSize, type PaneSpec } from './paneResizer'

/**
 * Shell layout: the sizes the user has dragged the frame into, and the scroll
 * offsets the lists were left at.
 *
 * This exists because the tab row is the router, and a router unmounts. Before
 * it, every one of these lived inside a routed component: the sidebar's width
 * inside `UDashboardPanel`, the track list's scroll offsets inside a `Map` in
 * `TrackList.vue`. Switching to Now Playing and back reset all of them, which
 * is not a state machine anybody designed — it is the mounting lifecycle
 * showing through the UI.
 *
 * Split the way `columnLayout` is split: all of the behaviour is here, free of
 * Pinia and of storage, and `stores/shell.ts` is the one place the real view
 * store is bolted on. That is what lets the rules be tested without a DOM.
 *
 * Persisted, unlike the cover pane's flag. A dragged sidebar is a layout the
 * user built and expects to find again; an expanded cover is a glance.
 */

/**
 * One record of pane key to size, held by the view store.
 *
 * The record shape survived W8-3 rather than becoming a key per pane, because
 * a pane's default, minimum and neighbour reserve are already stated once in
 * its `PaneSpec` and a scalar descriptor would restate two of them. It is also
 * what keeps a pane this build has never heard of: a pane an older binary does
 * not know is a pane a newer one owns, and running the old one once should not
 * discard the size the new one stored.
 */
export const SHELL_PANE_SIZES_KEY = 'view.shellPaneSizes'

/**
 * The frame's sidebar.
 *
 * `reserve` is the body's wide-mode `min-w-90` (360). Below ~760 the frame stops
 * keeping the rail beside the body and reflows it into a band (§2), so the drag
 * only has to leave the body room while the two are side by side: with the 640px
 * `minWidth`, sidebar `min` (240) plus this reserve (360) clears the floor with
 * slack, and on anything wider the drag stops before it can crush the body.
 */
export const SIDEBAR_PANE: PaneSpec = {
  key: 'shell.sidebar',
  axis: 'x',
  side: 'before',
  label: 'Sidebar width',
  defaultSize: 320,
  min: 240,
  max: 480,
  reserve: 360
}

/**
 * The reflowed rail's band height (§2).
 *
 * When the frame drops the side rail into a band above the body, that band is the
 * `before` pane of a vertical split the same way the sidebar is the `before` pane
 * of a horizontal one — so it gets the same `PaneResizer`, turned on its side, and
 * the same one stored number. `reserve` is the body's own floor below it (a list
 * header and a few rows); `max` keeps the band from swallowing the view on a tall,
 * narrow window where the reflow is on but the height is not the thing that is
 * scarce. Its own key, so a dragged band height and a dragged sidebar width do not
 * overwrite each other across the wide/compact switch.
 */
export const SHELL_BAND_PANE: PaneSpec = {
  key: 'shell.band',
  axis: 'y',
  side: 'before',
  label: 'Sources band height',
  defaultSize: 224,
  min: 140,
  max: 520,
  reserve: 200
}

/**
 * The Artists half of the Sources split.
 *
 * Only the upper pane has a size: the lower one takes what is left, so there is
 * one number to store and no way for the two to add up to something other than
 * the container. `reserve` is the Albums pane's own minimum — its rows are 44px
 * against the artists' 32px, so it needs more of them to be worth showing.
 */
export const SOURCES_ARTISTS_PANE: PaneSpec = {
  key: 'sources.artists',
  axis: 'y',
  side: 'before',
  label: 'Artists pane height',
  defaultSize: 280,
  min: 128,
  reserve: 176
}

/**
 * The Genres & tags pane, top of the Sources stack (W15-6).
 *
 * The same one-number rule as `SOURCES_ARTISTS_PANE`: this pane carries a
 * height and the Artists/Albums split below takes what is left, so a drag on its
 * handle moves one stored size. `reserve` is that split's own floor — the
 * Artists minimum plus the Albums reserve it already keeps (128 + 176) — so
 * growing genres can shrink the two lists below but never crush them past the
 * point of use. `min` clears the header and a couple of 28px rows.
 */
export const SOURCES_GENRES_PANE: PaneSpec = {
  key: 'sources.genres',
  axis: 'y',
  side: 'before',
  label: 'Genres and tags pane height',
  defaultSize: 148,
  min: 96,
  reserve: 304
}

/**
 * The Subscriptions half of the Podcasts sidebar split.
 *
 * The same shape as `SOURCES_ARTISTS_PANE`: only the upper pane carries a size
 * and Recent below takes what is left, so there is one number to store. `min`
 * clears the section header, the pinned Discover row and a subscription or two;
 * `reserve` is Recent's own minimum — its rows are 52px, so it needs the room
 * of the `min-h-40` the lower section also carries as a CSS backstop.
 */
export const PODCASTS_SUBSCRIPTIONS_PANE: PaneSpec = {
  key: 'podcasts.subscriptions',
  axis: 'y',
  side: 'before',
  label: 'Subscriptions pane height',
  defaultSize: 300,
  min: 140,
  reserve: 160
}

export interface ShellLayoutDeps {
  settings: ViewSettings
}

export function createShellLayout(deps: ShellLayoutDeps) {
  const settings = deps.settings
  const paneSizes = settings.value<Record<string, number>>(SHELL_PANE_SIZES_KEY)

  /**
   * The pane's size, or its default, held inside its bounds either way.
   *
   * Sizes are not clamped on the way out of storage. The bounds depend on the
   * container, which is not measured at the moment a layout is read, so the
   * descriptor validates that a size *is* a positive whole number of pixels and
   * this clamps it to what will fit — at the point of use, where the
   * measurement exists.
   */
  function sizeOf(spec: PaneSpec, containerPx?: number): number {
    return clampPaneSize(spec, paneSizes.value[spec.key] ?? spec.defaultSize, containerPx)
  }

  function setSize(spec: PaneSpec, px: number, containerPx?: number): void {
    const next = clampPaneSize(spec, px, containerPx)
    if (paneSizes.value[spec.key] === next) return
    paneSizes.value = { ...paneSizes.value, [spec.key]: next }
  }

  /** Back to the default, and stop storing a size for it. */
  function resetSize(spec: PaneSpec): void {
    if (!(spec.key in paneSizes.value)) return
    const next = { ...paneSizes.value }
    delete next[spec.key]
    paneSizes.value = next
  }

  /**
   * The pane's size as one two-way binding, for `v-model:size` on the handle
   * and a `width`/`height` on the pane itself.
   *
   * Handed out rather than reached for so that a call site names its pane once.
   * The handle clamps against the measured container before it emits; this
   * clamps again without one, which is a no-op for anything the handle sent and
   * a guard for anything else.
   */
  function paneSize(spec: PaneSpec): WritableComputedRef<number> {
    return computed({
      get: () => sizeOf(spec),
      set: (px: number) => setSize(spec, px)
    })
  }

  return { paneSizes, sizeOf, setSize, resetSize, paneSize }
}

export type ShellLayout = ReturnType<typeof createShellLayout>

/**
 * How many lists' scroll offsets are worth remembering.
 *
 * Bounded because the keys are not: a browse predicate is one key per distinct
 * artist-and-album selection, so an afternoon of clicking around the facets
 * would otherwise accumulate thousands of entries for lists nobody will return
 * to. Least-recently-used, since the list most likely to be reopened is the one
 * most recently left.
 */
export const MAX_REMEMBERED_SCROLLS = 32

export interface ScrollMemory {
  remember(key: string, top: number): void
  recall(key: string): number
  forget(key: string): void
  readonly size: number
}

/**
 * Where each list was left, for the length of the session.
 *
 * A bounded LRU of one number per key, and deliberately incurious about what
 * that number counts — `TrackList` puts a *row* here rather than a pixel offset,
 * because the operator can change the row height from another tab while the list
 * is unmounted and an offset means nothing afterwards. Anything monotonic in
 * position would do; what this owns is the eviction, not the unit.
 *
 * Not persisted, unlike the pane sizes. A position is a position in a specific
 * set of rows, and a restart is exactly when that set may have been rescanned
 * out from under it — restoring row 8,000 of a library that now has 300 tracks
 * is worse than restoring nothing.
 */
export function createScrollMemory(limit: number = MAX_REMEMBERED_SCROLLS): ScrollMemory {
  const offsets = new Map<string, number>()

  return {
    remember(key: string, top: number): void {
      if (!key) return
      // Deleted before it is set so that re-remembering moves the key to the
      // end of the insertion order, which is what makes the eviction below LRU
      // rather than first-in-first-out.
      offsets.delete(key)
      offsets.set(key, Math.max(0, Math.round(top)))
      while (offsets.size > limit) {
        const oldest = offsets.keys().next()
        if (oldest.done) break
        offsets.delete(oldest.value)
      }
    },
    recall(key: string): number {
      return offsets.get(key) ?? 0
    },
    forget(key: string): void {
      offsets.delete(key)
    },
    get size(): number {
      return offsets.size
    }
  }
}

/**
 * Which way the tab row moved, for the direction the body slides in from.
 *
 * Indices rather than names, because the order the tabs are drawn in is the
 * only thing that makes "forward" mean anything. `none` covers the first tab of
 * the session and a route that is not a tab at all — both cases where a
 * direction would be invented rather than observed, and where the body should
 * simply appear.
 */
export type TabDirection = 'forward' | 'back' | 'none'

export function tabDirection(previousIndex: number, nextIndex: number): TabDirection {
  if (previousIndex < 0 || nextIndex < 0 || previousIndex === nextIndex) return 'none'
  return nextIndex > previousIndex ? 'forward' : 'back'
}
