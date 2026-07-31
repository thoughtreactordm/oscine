import { computed, ref, type WritableComputedRef } from 'vue'
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
 * Pinia and of `localStorage`, and `stores/shell.ts` is the one place the real
 * storage is bolted on. That is what lets the rules be tested without a DOM.
 *
 * Persisted, unlike the cover pane's flag. A dragged sidebar is a layout the
 * user built and expects to find again; an expanded cover is a glance.
 */

export const SHELL_LAYOUT_STORAGE_KEY = 'fermata.shellLayout.v1'

/**
 * The frame's sidebar.
 *
 * `reserve` is the body's `min-w-120`. Together with the window's 940px
 * `minWidth` it means the drag stops at 460 on the narrowest allowed window and
 * at the full 480 on anything wider, rather than overflowing the row.
 */
export const SIDEBAR_PANE: PaneSpec = {
  key: 'shell.sidebar',
  axis: 'x',
  side: 'before',
  label: 'Sidebar width',
  defaultSize: 320,
  min: 240,
  max: 480,
  reserve: 480
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

export interface ShellLayoutStorage {
  read(): string | null
  write(value: string): void
}

/**
 * `localStorage`, guarded.
 *
 * A deliberate near-copy of `browserLayoutStorage` rather than an import of it,
 * for the reason `browserPlaylistSessionStorage` gives — and here with a second
 * one: this module is unit-tested, so it stays clear of the `@renderer` alias
 * that `tests/`' tsconfig does not map. Storage can fail on quota or with site
 * data disabled, and a pane width is not worth taking the frame down for.
 */
export function browserShellLayoutStorage(
  key: string = SHELL_LAYOUT_STORAGE_KEY
): ShellLayoutStorage {
  return {
    read: () => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    write: (value) => {
      try {
        globalThis.localStorage?.setItem(key, value)
      } catch {
        // Nothing useful to do: the layout stays correct for this session.
      }
    }
  }
}

export interface ShellLayoutState {
  /** Pane sizes in CSS pixels, keyed by `PaneSpec.key`. */
  paneSizes: Record<string, number>
}

export function defaultShellLayout(): ShellLayoutState {
  return { paneSizes: {} }
}

/**
 * A stored layout, made safe to use.
 *
 * Unrecognised keys are kept rather than dropped. A pane this build has never
 * heard of is a pane a neighbouring build owns — running an older binary once
 * should not silently discard the sizes the newer one stored.
 *
 * Sizes are not clamped here. The bounds depend on the container, which is not
 * measured at the moment a layout is read; `sizeOf` clamps at the point of use,
 * where the measurement exists.
 */
export function normalizeShellLayout(raw: unknown): ShellLayoutState {
  const layout = defaultShellLayout()
  if (typeof raw !== 'object' || raw === null) return layout

  const sizes = (raw as { paneSizes?: unknown }).paneSizes
  if (typeof sizes !== 'object' || sizes === null) return layout

  for (const [key, value] of Object.entries(sizes)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      layout.paneSizes[key] = Math.round(value)
    }
  }
  return layout
}

export interface ShellLayoutDeps {
  storage?: ShellLayoutStorage
}

export function createShellLayout(deps: ShellLayoutDeps = {}) {
  const storage = deps.storage
  const state = ref<ShellLayoutState>(normalizeShellLayout(readStored()))

  function readStored(): unknown {
    const raw = storage?.read()
    if (raw === null || raw === undefined) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function persist(): void {
    storage?.write(JSON.stringify(state.value))
  }

  /** The pane's size, or its default, held inside its bounds either way. */
  function sizeOf(spec: PaneSpec, containerPx?: number): number {
    return clampPaneSize(spec, state.value.paneSizes[spec.key] ?? spec.defaultSize, containerPx)
  }

  function setSize(spec: PaneSpec, px: number, containerPx?: number): void {
    const next = clampPaneSize(spec, px, containerPx)
    if (state.value.paneSizes[spec.key] === next) return
    state.value.paneSizes[spec.key] = next
    persist()
  }

  /** Back to the default, and stop storing a size for it. */
  function resetSize(spec: PaneSpec): void {
    if (!(spec.key in state.value.paneSizes)) return
    delete state.value.paneSizes[spec.key]
    persist()
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

  return { paneSizes: state, sizeOf, setSize, resetSize, paneSize }
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
 * Not persisted, unlike the pane sizes. An offset is a position in a specific
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
