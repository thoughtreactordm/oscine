import { computed } from 'vue'
import { TRACK_SORT_COLUMNS, type Track, type TrackSortColumn } from '@shared/library'
import type { StoredColumnLayout } from '@shared/settings'
import type { ViewSettings } from '../settings/viewStore'

/**
 * The track list's column layout: which columns, in what order, how wide.
 *
 * Two things make this its own module rather than component state. It has to
 * survive a restart, so what comes back from storage is reconciled against the
 * catalogue rather than trusted — a stale or hand-edited blob must degrade to
 * the defaults, not to a table with no columns. And the rules are worth testing
 * without a DOM: that the last visible column cannot be hidden, that an unknown
 * key from a future version is dropped rather than rendered, that a reset
 * restores exactly the documented set.
 *
 * The view store is injected. W8-3 took the storage wrapper and the JSON
 * `try`/`catch` that used to live here; what stayed is `normalizeColumnLayout`,
 * because every rule in it is a question about *the catalogue below* — is this
 * a real column, is that width above its minimum, would this hide the last one
 * — and the catalogue is renderer presentation data. The descriptor validates
 * that a stored layout is three fields of strings and numbers; this decides
 * what those strings mean. It is the split `clampPaneSize` already made.
 */

export type TrackColumnKey = TrackSortColumn | DisplayColumnKey | VirtualColumnKey

/**
 * Columns whose value is not a field on `Track` at all — **W15-5**.
 *
 * Every other column reads a value straight off the display row `listTracks`
 * already ships. `tags` cannot: a track's genres and user tags are a separate
 * projection, fetched out-of-band for the rendered window and cached in the tags
 * store, deliberately kept off the `Track` row so the audio-admission path stays
 * lean (see the invariant in CLAUDE.md — `Track` budgets whole-buffer decode).
 * The catalogue still renders it; the cell just reads the store instead of the
 * row, the way `favorite` reads a boolean the query happens to include but a chip
 * cell draws specially. Exempt from the `keyof Track` guard below for this reason
 * and this reason only.
 */
type VirtualColumnKey = 'tags'

/**
 * Columns the list can show but the library cannot sort by.
 *
 * Sorting is a SQL concern: `TRACK_SORT_COLUMNS` is the closed set main will put
 * in an ORDER BY, and offering a header click for anything else would promise an
 * ordering that does not exist. Showing the value costs nothing, so these are
 * available as columns and simply are not sortable.
 */
type DisplayColumnKey =
  | 'favorite'
  | 'albumArtist'
  | 'discNo'
  | 'year'
  | 'codec'
  | 'sampleRateHz'
  | 'bitDepth'
  | 'channels'
  | 'encodedBytes'

export interface TrackColumnSpec {
  readonly key: TrackColumnKey
  readonly label: string
  /** Long-form name for the column chooser, where the header abbreviation is opaque. */
  readonly title?: string
  /** Right-aligned with tabular numerals, so digits line up down the column. */
  readonly numeric?: boolean
  readonly defaultWidth: number
  readonly minWidth: number
  /** Present in the default layout. */
  readonly defaultVisible: boolean
}

/**
 * Every column the list knows how to render.
 *
 * Order here is the default order and the chooser's listing order. The five
 * visible ones are exactly what W4-1 shipped, so an existing user's table does
 * not rearrange itself the first time they open this build.
 */
export const TRACK_COLUMNS: readonly TrackColumnSpec[] = [
  {
    key: 'trackNo',
    label: '#',
    title: 'Track number',
    numeric: true,
    defaultWidth: 56,
    minWidth: 40,
    defaultVisible: true
  },
  {
    key: 'title',
    label: 'Title',
    defaultWidth: 320,
    minWidth: 96,
    defaultVisible: true
  },
  {
    key: 'artist',
    label: 'Artist',
    defaultWidth: 220,
    minWidth: 80,
    defaultVisible: true
  },
  {
    key: 'album',
    label: 'Album',
    defaultWidth: 220,
    minWidth: 80,
    defaultVisible: true
  },
  {
    key: 'durationSec',
    label: 'Time',
    title: 'Duration',
    numeric: true,
    defaultWidth: 72,
    minWidth: 56,
    defaultVisible: true
  },
  {
    key: 'albumArtist',
    label: 'Album artist',
    defaultWidth: 200,
    minWidth: 80,
    defaultVisible: false
  },
  {
    key: 'discNo',
    label: 'Disc',
    numeric: true,
    defaultWidth: 64,
    minWidth: 48,
    defaultVisible: false
  },
  {
    key: 'year',
    label: 'Year',
    numeric: true,
    defaultWidth: 72,
    minWidth: 56,
    defaultVisible: false
  },
  {
    key: 'codec',
    label: 'Format',
    defaultWidth: 96,
    minWidth: 64,
    defaultVisible: false
  },
  {
    key: 'sampleRateHz',
    label: 'Sample rate',
    numeric: true,
    defaultWidth: 112,
    minWidth: 80,
    defaultVisible: false
  },
  {
    key: 'bitDepth',
    label: 'Bit depth',
    numeric: true,
    defaultWidth: 96,
    minWidth: 72,
    defaultVisible: false
  },
  {
    key: 'channels',
    label: 'Channels',
    numeric: true,
    defaultWidth: 96,
    minWidth: 72,
    defaultVisible: false
  },
  {
    key: 'encodedBytes',
    label: 'Size',
    title: 'File size',
    numeric: true,
    defaultWidth: 96,
    minWidth: 72,
    defaultVisible: false
  },
  // Off by default like every column added after W4-1, and for a stronger reason
  // than the rest: on a library that has never been listened to in Oscine these
  // two are a column of zeros and a column of dashes. They are worth having the
  // moment there is a log behind them, and worth not imposing before then.
  {
    key: 'playCount',
    label: 'Plays',
    title: 'Times listened',
    numeric: true,
    defaultWidth: 80,
    minWidth: 64,
    defaultVisible: false
  },
  {
    key: 'lastPlayedAt',
    label: 'Last played',
    numeric: true,
    defaultWidth: 140,
    minWidth: 96,
    defaultVisible: false
  },
  // D18's heart. Off by default like everything added after W4-1, and narrow:
  // the cell is one glyph and the header is one word.
  //
  // The header is "Fav" rather than a ♥ matching the cells, which is what every
  // other player does. The label is read aloud, and a screen reader announcing
  // this column as "black heart suit" is worse than an abbreviation whose long
  // form is one `title` away — the same split `#` and "Track number" already
  // make.
  //
  // Not numeric, despite being about as wide as one: `numeric` right-aligns and
  // applies tabular numerals, and the glyph is centred by the cell itself.
  {
    key: 'favorite',
    label: 'Fav',
    title: 'Favorite',
    defaultWidth: 48,
    minWidth: 40,
    defaultVisible: false
  },
  // W15-5 — file genres and the operator's own tags, one column. Off by default
  // like everything added after W4-1, and unsortable because it is not in
  // `TRACK_SORT_COLUMNS`: there is no single value to order a multi-chip cell by.
  // The cell draws chips from the tags store rather than a `Track` field, which
  // is what makes `tags` a `VirtualColumnKey`.
  {
    key: 'tags',
    label: 'Tags',
    title: 'Genre & tags',
    defaultWidth: 200,
    minWidth: 96,
    defaultVisible: false
  }
]

const COLUMNS_BY_KEY = new Map(TRACK_COLUMNS.map((column) => [column.key, column]))

/**
 * Whether the header for this column offers a sort.
 *
 * Derived from `TRACK_SORT_COLUMNS` rather than declared per column, so the
 * catalogue cannot claim a sort main will reject. Adding a column to the shared
 * allowlist is all it takes for its header to become clickable.
 */
export function isSortableColumn(key: TrackColumnKey): key is TrackSortColumn {
  return (TRACK_SORT_COLUMNS as readonly string[]).includes(key)
}

/** Compile-time proof that every sortable column has an entry in the catalogue. */
type UnlistedSortColumn = Exclude<TrackSortColumn, TrackColumnKey>
const _everySortColumnListed: UnlistedSortColumn extends never ? true : never = true
void _everySortColumnListed

/**
 * …and that every column either names a real `Track` field to read or is a
 * declared virtual column. A field column that named no `Track` field is still a
 * compile error; only `VirtualColumnKey` is exempt, and only because its cell
 * reads the tags store rather than the row (see the note on `VirtualColumnKey`).
 */
type UnreadableColumn = Exclude<TrackColumnKey, keyof Track | VirtualColumnKey>
const _everyColumnIsATrackField: UnreadableColumn extends never ? true : never = true
void _everyColumnIsATrackField

export interface TrackColumnLayout {
  order: TrackColumnKey[]
  hidden: TrackColumnKey[]
  widths: Partial<Record<TrackColumnKey, number>>
}

export const TRACK_COLUMNS_KEY = 'view.trackColumns'

/** The maximum a column can be dragged to. Wide enough for a long path-like title. */
const MAX_COLUMN_WIDTH = 800

export function defaultColumnLayout(): TrackColumnLayout {
  return {
    order: TRACK_COLUMNS.map((column) => column.key),
    hidden: TRACK_COLUMNS.filter((column) => !column.defaultVisible).map((column) => column.key),
    widths: {}
  }
}

function isColumnKey(value: unknown): value is TrackColumnKey {
  return typeof value === 'string' && COLUMNS_BY_KEY.has(value as TrackColumnKey)
}

function clampWidth(spec: TrackColumnSpec, width: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(spec.minWidth, width)))
}

/**
 * Reconciles a stored layout with the catalogue this build ships.
 *
 * Every field is treated as a suggestion. Unknown keys are dropped so a layout
 * saved by a newer build does not render a phantom column; known keys missing
 * from `order` are appended so a *newer* build's added column appears rather
 * than vanishing; and a layout that would hide everything falls back to the
 * default visible set, because a table with no columns has no way back.
 *
 * `null` is a profile that has never configured its columns, which is not the
 * same as one that has unhidden everything — an empty `hidden` is a real state
 * and must not be read as a fresh start.
 */
export function normalizeColumnLayout(stored: StoredColumnLayout | null): TrackColumnLayout {
  const layout = defaultColumnLayout()
  if (stored === null) return layout

  const seen = new Set<TrackColumnKey>()
  const order: TrackColumnKey[] = []
  for (const key of stored.order) {
    if (!isColumnKey(key) || seen.has(key)) continue
    seen.add(key)
    order.push(key)
  }
  // Columns this build knows about but the stored layout did not.
  for (const column of TRACK_COLUMNS) if (!seen.has(column.key)) order.push(column.key)
  layout.order = order

  const hidden = [...new Set(stored.hidden.filter(isColumnKey))]
  if (hidden.length < layout.order.length) layout.hidden = hidden

  const widths: Partial<Record<TrackColumnKey, number>> = {}
  for (const [key, width] of Object.entries(stored.widths)) {
    if (!isColumnKey(key)) continue
    widths[key] = clampWidth(COLUMNS_BY_KEY.get(key)!, width)
  }
  layout.widths = widths

  return layout
}

export interface ColumnLayoutDeps {
  settings: ViewSettings
}

export function createColumnLayout(deps: ColumnLayoutDeps) {
  const settings = deps.settings
  const stored = settings.value<StoredColumnLayout | null>(TRACK_COLUMNS_KEY)
  const layout = computed<TrackColumnLayout>(() => normalizeColumnLayout(stored.value))

  /**
   * Stores the layout as three lists of plain strings.
   *
   * The reconciled form is what the panel reads; the stored form is what the
   * descriptor validates. They are written apart so that a column dropped from
   * a future catalogue is dropped on *read* rather than erased on the next
   * write — the same reason unknown pane keys survive.
   */
  function write(next: TrackColumnLayout): void {
    const widths: Record<string, number> = {}
    for (const [key, width] of Object.entries(next.widths)) {
      if (typeof width === 'number') widths[key] = width
    }
    stored.value = { order: [...next.order], hidden: [...next.hidden], widths }
  }

  const hidden = computed(() => new Set(layout.value.hidden))

  /** Every column in user order, hidden ones included — the chooser's listing. */
  const orderedColumns = computed<readonly TrackColumnSpec[]>(() =>
    layout.value.order.map((key) => COLUMNS_BY_KEY.get(key)!).filter((spec) => spec !== undefined)
  )

  const visibleColumns = computed<readonly TrackColumnSpec[]>(() =>
    orderedColumns.value.filter((column) => !hidden.value.has(column.key))
  )

  function widthOf(key: TrackColumnKey): number {
    const spec = COLUMNS_BY_KEY.get(key)
    if (!spec) return 0
    return layout.value.widths[key] ?? spec.defaultWidth
  }

  /**
   * Total width of the visible columns.
   *
   * The table is laid out `table-fixed` at this width so the numbers the user
   * dragged are the numbers they get. Below the container width CSS spreads the
   * slack; above it the panel scrolls horizontally.
   */
  const totalWidth = computed(() =>
    visibleColumns.value.reduce((sum, column) => sum + widthOf(column.key), 0)
  )

  function isVisible(key: TrackColumnKey): boolean {
    return !hidden.value.has(key)
  }

  /**
   * Shows or hides a column.
   *
   * Refuses to hide the last visible one: an empty table offers no header to
   * click and no way to get a column back.
   */
  function toggleVisible(key: TrackColumnKey): boolean {
    if (!COLUMNS_BY_KEY.has(key)) return false
    const next = new Set(layout.value.hidden)
    if (next.has(key)) next.delete(key)
    else if (visibleColumns.value.length > 1) next.add(key)
    else return false

    write({ ...layout.value, hidden: [...next] })
    return true
  }

  /**
   * Moves a column by `delta` positions among the *visible* ones.
   *
   * Stepping over hidden columns would make a keyboard reorder skip unpredictably
   * — the user would press the key twice and see nothing move.
   */
  function move(key: TrackColumnKey, delta: number): boolean {
    if (!isVisible(key) || delta === 0) return false
    const visible = visibleColumns.value.map((column) => column.key)
    const from = visible.indexOf(key)
    const to = from + delta
    if (from < 0 || to < 0 || to >= visible.length) return false
    return moveBefore(key, visible[to]!, delta > 0)
  }

  /**
   * Places `key` immediately before or after `target` in the full order.
   *
   * Both the pointer drop and the keyboard step funnel through here so the two
   * cannot disagree about what "after" means when hidden columns sit between.
   */
  function moveBefore(key: TrackColumnKey, target: TrackColumnKey, after: boolean): boolean {
    if (key === target || !COLUMNS_BY_KEY.has(key) || !COLUMNS_BY_KEY.has(target)) return false
    const order = layout.value.order.filter((entry) => entry !== key)
    const at = order.indexOf(target)
    if (at < 0) return false
    order.splice(after ? at + 1 : at, 0, key)
    write({ ...layout.value, order })
    return true
  }

  /**
   * Sets a column's width, clamped to its minimum.
   *
   * This used to take a `persist: false` for a drag in progress, because a
   * resize fires on every pointer move and writing to storage sixty times a
   * second is the kind of thing that shows up later as jank. The view store
   * debounces its writes now, so every caller says the same thing and the
   * coalescing happens once, below, for panes and columns alike. `persist()`
   * survives as the flush a caller does on release.
   */
  function setWidth(key: TrackColumnKey, width: number): void {
    const spec = COLUMNS_BY_KEY.get(key)
    if (!spec || !Number.isFinite(width)) return
    write({ ...layout.value, widths: { ...layout.value.widths, [key]: clampWidth(spec, width) } })
  }

  function nudgeWidth(key: TrackColumnKey, delta: number): void {
    setWidth(key, widthOf(key) + delta)
  }

  function specOf(key: TrackColumnKey): TrackColumnSpec | undefined {
    return COLUMNS_BY_KEY.get(key)
  }

  /**
   * Restores the documented default set: order, visibility and widths together.
   *
   * Forgets the stored layout rather than storing today's defaults, so a build
   * that adds a column reaches a table that was reset before it existed.
   */
  function reset(): void {
    settings.reset(TRACK_COLUMNS_KEY)
  }

  /** Writes anything the debounce is still holding — a caller's drag release. */
  function persist(): void {
    settings.flush()
  }

  return {
    layout,
    orderedColumns,
    visibleColumns,
    totalWidth,
    isVisible,
    widthOf,
    specOf,
    toggleVisible,
    move,
    moveBefore,
    setWidth,
    nudgeWidth,
    persist,
    reset
  }
}

export type ColumnLayout = ReturnType<typeof createColumnLayout>
