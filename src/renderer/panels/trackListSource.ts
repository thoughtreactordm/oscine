import type { ContextMenuItem } from '@nuxt/ui'
import type { SelectionIntent, SelectionModifiers } from '@renderer/panels/indexedSelection'
import type { GroupedRun } from '@renderer/panels/trackGrouping'
import type { SortDirection, Track, TrackGroup, TrackSortColumn } from '@shared/library'

/**
 * What `TrackList` needs of the list underneath it.
 *
 * The island rule (D4) said the panel assumes nothing about its neighbours; this
 * is the same rule pointed downwards. Until W5-6 the component reached straight
 * into `useTrackListStore`, which made "the song list" and "the library" the
 * same object — and the playlist contents pane is the same list over a different
 * sequence. Naming the surface is what lets one virtualized implementation serve
 * both instead of a second one growing beside it.
 *
 * Deliberately structural and deliberately small. Every member here is something
 * the component actually renders or calls; a source is free to be a Pinia store,
 * a window, or a fake in a test.
 */
export interface TrackListSource {
  readonly total: number
  readonly loading: boolean
  /**
   * Ordering generation. Bumped whenever row *positions* move — a re-sort in the
   * library, an edit in a playlist — so anything the component derived from an
   * index is known to be stale.
   */
  readonly ordering: number
  /** Album runs, or empty for a list that is not album-major. */
  readonly groups: readonly TrackGroup[]

  /**
   * The column the list is ordered by, or `null` where no column owns the order.
   *
   * `null` is the playlist contents pane: its order is a stored position, so a
   * sortable header would offer an ordering the store cannot express and a
   * reorder drag could not be interpreted against. The component renders inert
   * headers rather than headers that lie.
   */
  readonly sort: TrackSortColumn | null
  readonly direction: SortDirection
  /** Only reached when `sort` is non-null. */
  setSort?: (column: TrackSortColumn) => void

  /**
   * Identity of the list itself, for scroll memory.
   *
   * The library keys it by the browse predicate and a playlist by its id; both
   * mean "the rows underneath are a different set now, so the pixel offset the
   * user was at belongs to the other one".
   */
  readonly scrollKey: string

  readonly selectionCount: number
  readonly anchorIndex: number | null
  readonly focusIndex: number | null
  readonly focusedTrack: Track | null

  rowAt: (index: number) => Track | undefined
  ensureRange: (first: number, last: number) => void
  isSelectedAt: (index: number) => boolean
  selectAt: (index: number, intent: SelectionIntent) => void | Promise<void>
  clearSelection: () => void
  commitFocus: (modifiers: SelectionModifiers) => void
  moveFocus: (key: string, rowsPerPage: number, modifiers?: SelectionModifiers) => number | null
}

/** Which edge of a row a drop lands against. Named as `playlistTabs` names it. */
export type RowDropSide = 'before' | 'after'

/**
 * Row drag and drop, when the list has any.
 *
 * Optional, and absent by default: a list that nobody drags into or out of is a
 * list with no drag handlers bound at all, rather than one carrying a set of
 * no-ops. `index` is `null` for the empty area past the last row, which is a
 * real gesture — "put it at the end" — and not a miss.
 */
export interface TrackListDrag {
  /** Whether rows can be picked up here. */
  readonly enabled: boolean
  /** The edge to draw a drop marker on for this row, or `null` for none. */
  indicatorAt: (index: number) => RowDropSide | null
  /** Picks rows up. `false` when there is nothing at `index` to carry. */
  start: (index: number) => boolean
  /** `true` claims the drag; the component then calls `preventDefault` for it. */
  over: (index: number | null, side: RowDropSide) => boolean
  drop: () => void
  end: () => void
}

/**
 * The row context menu, when the list has one.
 *
 * Built per right-click rather than held as a list, because the verbs depend on
 * what is selected — "Add 4,312 tracks to…" is a different item from "Add to…".
 */
export type TrackListMenu = (index: number) => ContextMenuItem[]

/**
 * The album-header menu, when the list draws headers.
 *
 * Takes the run rather than an index, because that is the whole of what its
 * verbs are about: a run knows where its rows start (`firstOffset`) and how
 * many there are (`group.trackCount`), which is everything needed to resolve
 * the album through the same range reader a Shift-range uses.
 *
 * Deliberately independent of the selection. "Add this album to a playlist" is
 * about the album under the pointer whatever else is ticked, and a menu that
 * silently reselected would destroy work the operator had done to get there.
 */
export type TrackListGroupMenu = (run: GroupedRun) => ContextMenuItem[]
