<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { TableColumn, TableRow } from '@nuxt/ui'
import {
  isSortableColumn,
  type TrackColumnKey,
  type TrackColumnSpec
} from '@renderer/panels/columnLayout'
import { selectionIntent } from '@renderer/panels/indexedSelection'
import {
  nowPlayingIcon,
  nowPlayingLabel,
  nowPlayingMark,
  type NowPlayingMark
} from '@renderer/panels/nowPlayingMark'
import {
  displayAtPx,
  displayTopPx,
  groupedLayout,
  identityLayout,
  type GroupedRun,
  type GroupLayout,
  type RowMetrics
} from '@renderer/panels/trackGrouping'
import type {
  RowDropSide,
  TrackListDrag,
  TrackListGroupMenu,
  TrackListMenu,
  TrackListSource
} from '@renderer/panels/trackListSource'
import { useTrackColumnsStore } from '@renderer/stores/columns'
import { useDisplayFormatStore } from '@renderer/stores/displayFormat'
import { useFavoritesStore } from '@renderer/stores/favorites'
import { useTrackGroupingStore } from '@renderer/stores/grouping'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'
import { useTagsStore } from '@renderer/stores/tags'
import type { Track } from '@shared/library'
import type { TrackTagView } from '@shared/tags'

/**
 * The virtualized song list.
 *
 * One implementation, two lists. It reached into the track list store until
 * W5-6, which made "the song list" and "the library" the same object; the
 * playlist contents pane is the same virtualized list over a different sequence,
 * so the rows now arrive through `TrackListSource` and the component no longer
 * knows which of the two it is drawing. Drag and the row menu are optional
 * capabilities for the same reason: a list nobody drags into binds no drag
 * handlers rather than carrying a set of no-ops.
 *
 * Two things are deliberately not delegated to Nuxt UI here, and both for the
 * same reason — the component is virtualizing 100k rows and neither feature can
 * be expressed against rows it has not mounted.
 *
 * Selection does not use `v-model:row-selection`. TanStack's selection state is
 * a map keyed by row id, which for us is a *position*; feeding it our id-based
 * selection would mean holding a position for every selected row and rebuilding
 * an object of them on every click, and it would still be wrong the moment a
 * re-sort moved the rows. Rows are styled from `source.isSelectedAt` instead,
 * which asks the loaded row for its id and tests set membership — correct after
 * a re-sort, and costing nothing for the 99% of the library that is not mounted.
 *
 * Column widths are ours too, because Nuxt UI applies `meta.style`, not
 * TanStack's `columnSizing`, to the DOM. Since the widths have to be persisted
 * anyway, one source of truth in `columnLayout` is simpler than two.
 */

const props = defineProps<{
  /** The rows, the selection and the ordering. See `TrackListSource`. */
  source: TrackListSource
  /** Row drag and drop, when the list has any. */
  drag?: TrackListDrag
  /** The row context menu, when the list has one. */
  menu?: TrackListMenu
  /**
   * The album-header menu, when the list has one.
   *
   * A separate prop from `menu` because it is aimed at a different thing: the
   * run, not a row, and every one of its verbs acts on the whole album whatever
   * happens to be selected. Absent by default, and the button is not drawn at
   * all without it — a dead affordance is worse than none, which is what that
   * button was until now.
   */
  groupMenu?: TrackListGroupMenu
  /** What the list is called, for assistive technology. */
  label?: string
}>()

const emit = defineEmits<{
  select: [track: Track]
  activate: [track: Track, index: number]
}>()

const columns = useTrackColumnsStore()
const grouping = useTrackGroupingStore()
const formats = useDisplayFormatStore()
const playback = usePlaybackStore()
const shell = useShellStore()
const favorites = useFavoritesStore()
const tags = useTagsStore()
const OVERSCAN = 8
/** Pixels an arrow key moves a column edge. Shift narrows it to one. */
const WIDTH_STEP = 16

/**
 * The drop marker, drawn as a pseudo-element rather than as a border or a
 * second shadow.
 *
 * A border on a `tr` takes part in the table's border collapsing and lands
 * ragged against the first cell, which is why the range anchor is an inset
 * shadow already — and that is the problem with a shadow here: two arbitrary
 * `shadow-[…]` classes on one row are the same CSS property twice, and which
 * one won would depend on stylesheet order. A `::before` composes with both,
 * and with the selection tint underneath it.
 *
 * Written out rather than composed at runtime because Tailwind reads source
 * text: a class name assembled from parts is a class name that never ships.
 */
const DROP_BEFORE_CLASS =
  "relative before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-0.5 before:bg-primary before:content-['']"
const DROP_AFTER_CLASS =
  "relative before:absolute before:inset-x-0 before:bottom-0 before:z-10 before:h-0.5 before:bg-primary before:content-['']"

/**
 * One row the virtualizer draws.
 *
 * `index` is a *track offset* and stays that way, which is what keeps album
 * headers out of the selection contract: selection, the range anchor and
 * keyboard focus all address tracks by offset and never learn that headers
 * exist. `display` is the position on screen, and the two only differ by the
 * headers above.
 */
interface TrackTableRow {
  display: number
  /** `null` on an album header, which is not a track and cannot be selected. */
  index: number | null
  run: GroupedRun | null
}

const visibleColumns = computed(() => columns.visibleColumns)
/** The column an album header spans from. Follows the user's column order. */
const leadingColumnKey = computed(() => visibleColumns.value[0]?.key)

/**
 * The playing mark for a track offset, or `null`.
 *
 * Asked per cell rather than folded into `tableRows`, because the alternative is
 * rebuilding a 100k-entry array every time the transport changes track. Both
 * reads are O(1) — a loaded-page lookup and two comparisons — and both happen
 * inside the render effect, which is what makes the mark move on its own when
 * the next track starts. Exactly how `isSelectedAt` already works.
 */
function markAt(index: number | null): NowPlayingMark | null {
  if (index === null) return null
  return nowPlayingMark({
    trackId: props.source.rowAt(index)?.id,
    playingTrackId: playback.nowPlaying?.id ?? null,
    status: playback.status
  })
}

/**
 * The mark for one cell: only the leading column draws the glyph, so only the
 * leading column is asked.
 */
function cellMark(row: TrackTableRow, columnKey: TrackColumnKey): NowPlayingMark | null {
  if (row.run !== null || columnKey !== leadingColumnKey.value) return null
  return markAt(row.index)
}

/**
 * Whether to draw the "edited, not yet written" mark on this cell — **W16**.
 *
 * Leading column only, like {@link cellMark}: a track with an unwritten
 * correction gets one dot at the start of the row, not one per column.
 */
function cellModified(row: TrackTableRow, columnKey: TrackColumnKey): boolean {
  if (row.run !== null || columnKey !== leadingColumnKey.value) return false
  return trackAt(row)?.modified ?? false
}

function alignClass(column: TrackColumnSpec, playing = false): string {
  const tone = playing
    ? 'text-primary'
    : column.key === 'title'
      ? 'text-highlighted'
      : column.key === 'trackNo'
        ? 'text-dimmed'
        : 'text-muted'
  return column.numeric ? `text-right tabular-nums ${tone}` : tone
}

/**
 * Album headers are drawn with a column span, not with a second table.
 *
 * Nuxt UI resolves `meta.colspan.td` per *cell*, so the leading column can span
 * the whole row where a header sits and behave normally everywhere else. The
 * remaining columns hide their cell on those rows — a `<td>` that is not
 * displayed occupies no column, which is what leaves the span room to sit in.
 *
 * TanStack's own grouping is not an option here and would not have been simpler:
 * this table's data is 100k bare indices whose values are fetched a page at a
 * time, so a client-side row model can only see the rows already loaded and
 * would regroup the list as it scrolled.
 */
const tableColumns = computed<TableColumn<TrackTableRow>[]>(() =>
  visibleColumns.value.map((column, position) => {
    const width = `${columns.widthOf(column.key)}px`
    const leading = position === 0
    const spanned = visibleColumns.value.length

    return {
      id: column.key,
      header: column.label,
      accessorFn: (row: TrackTableRow) => row.index,
      meta: {
        class: {
          th: alignClass(column),
          td: (cell: { row: TableRow<TrackTableRow> }) => {
            // The playing row is tinted across every column, not just the one
            // holding the glyph: the table scrolls sideways, and a mark that
            // lives only in the leading column is a mark that scrolls away.
            if (!isHeaderRow(cell.row.original)) {
              return alignClass(column, markAt(cell.row.original.index) !== null)
            }
            return leading ? 'px-2 py-0 align-middle' : 'hidden'
          }
        },
        colspan: {
          // A string because that is what Nuxt UI resolves this to; '1' is the
          // default span and so is what an ordinary row wants.
          td: (cell: { row: TableRow<TrackTableRow> }) =>
            leading && isHeaderRow(cell.row.original) ? String(spanned) : '1'
        },
        style: {
          th: { width },
          td: (cell: { row: TableRow<TrackTableRow> }): Record<string, string> =>
            isHeaderRow(cell.row.original)
              ? { width: 'auto', height: `${grouping.rowPx}px` }
              : { width }
        }
      }
    }
  })
)

/**
 * Per-row classes.
 *
 * Passed as table `meta` because that is the only hook Nuxt UI resolves against
 * an individual row. Selection, keyboard focus and the range anchor are three
 * separate states and each is shown where it carries information: a user
 * building a disjoint selection has to be able to see where the next Shift+click
 * will measure from.
 */
const tableMeta = computed(() => ({
  class: {
    tr: (row: TableRow<TrackTableRow>) => {
      const index = row.original.index
      // Headers are scenery: not selectable, not hoverable, and visibly not a
      // row you can act on.
      if (index === null) return 'bg-elevated/40 hover:bg-elevated/40'

      const classes: string[] = []
      if (props.source.isSelectedAt(index)) classes.push('bg-primary/15')
      // Worth drawing only once there is a span to measure. On a single-row
      // selection the anchor *is* that row, so the marker says nothing and reads
      // as a stray sliver on the row's leading edge. Painted as an inset shadow
      // rather than a border because a border on a `tr` takes part in the
      // table's border collapsing and lands ragged against the first cell.
      if (props.source.anchorIndex === index && props.source.selectionCount > 1) {
        classes.push('shadow-[inset_2px_0_0_0_var(--ui-primary)]')
      }
      if (props.source.focusIndex === index) classes.push('ring-1 ring-inset ring-primary/70')
      const side = props.drag?.indicatorAt(index) ?? null
      if (side !== null) classes.push(side === 'before' ? DROP_BEFORE_CLASS : DROP_AFTER_CLASS)
      return classes.join(' ')
    }
  },
  style: {
    // The shared row class fixes every row at the track height, so a header has
    // to state its own — and it is the sleeve size that decides it.
    tr: (row: TableRow<TrackTableRow>): Record<string, string> =>
      row.original.run ? { height: `${grouping.rowPx}px` } : {}
  }
}))

const table = ref<{ $el?: HTMLElement } | null>(null)
const scrollTop = ref(0)

/**
 * Where this list was left, held outside the component.
 *
 * It was a `Map` here until the tab row became the router, which made it scroll
 * memory with a component's lifetime: the map went out of scope with the mount,
 * so every tab change sent the user back to row zero of a 100k list — and the
 * one thing worth remembering about a list that long is where they were in it.
 * The store keeps it for the session, keyed the same way and bounded, because
 * the keys are browse predicates and there is no ceiling on how many of those
 * an afternoon produces.
 *
 * Read once here rather than on mount: the restore below is an `immediate`
 * watcher, which runs during setup, before `onMounted` would have claimed it.
 *
 * What is remembered is the **display row** at the top, not its pixel offset.
 * The operator changes the row height on the Settings tab, which unmounts this
 * list — so the geometry watcher below never sees that change, and a pixel
 * offset handed back afterwards would land wherever the new height put it. A row
 * survives it, and survives an album-header resize and a grouping toggle with
 * it.
 */
let pendingAnchor: number | null = shell.recallScroll(props.source.scrollKey) || null

/**
 * Grouped when the ordering is album-major and the runs describe this list.
 *
 * The runs and the row count arrive on separate responses, so for a moment
 * after a re-sort they can disagree. Drawing ungrouped until they line up costs
 * a frame; drawing headers against a list that has moved on puts every row
 * underneath them beneath the wrong album.
 */
const layout = computed<GroupLayout>(() => {
  void props.source.ordering
  if (!grouping.enabled) return identityLayout(props.source.total)
  const grouped = groupedLayout(props.source.groups)
  return grouped.runs.length > 0 && grouped.trackCount === props.source.total
    ? grouped
    : identityLayout(props.source.total)
})

const tableRows = computed<TrackTableRow[]>(() => {
  void props.source.ordering
  const current = layout.value
  if (current.runs.length === 0) {
    return Array.from({ length: current.displayCount }, (_, index) => ({
      display: index,
      index,
      run: null
    }))
  }

  // Built by walking the runs rather than by asking the layout row by row: at
  // 100k rows the per-row binary search is real work for an answer the walk
  // already has.
  const rows: TrackTableRow[] = []
  for (const run of current.runs) {
    rows.push({ display: run.headerIndex, index: null, run })
    for (let offset = 0; offset < run.group.trackCount; offset++) {
      rows.push({
        display: run.headerIndex + 1 + offset,
        index: run.firstOffset + offset,
        run: null
      })
    }
  }
  return rows
})

/**
 * The heights the list is drawn at, as one value.
 *
 * Read together because they are read together: a track row and an album header
 * row are the only two sizes on screen, and every pixel answer this component
 * gives is a sum of the two.
 */
const metrics = computed<RowMetrics>(() => ({
  rowPx: formats.rowPx,
  headerPx: grouping.rowPx
}))

function estimateRowSize(display: number): number {
  return layout.value.rowAt(display)?.kind === 'header'
    ? metrics.value.headerPx
    : metrics.value.rowPx
}

/**
 * A height change is a *new* virtualizer, not a stale one.
 *
 * TanStack memoizes its measurements, and `estimateSize` is read inside that
 * memo rather than being one of its dependencies — the invalidation it expects
 * is `measure()`, which Nuxt UI's table neither calls nor exposes, since it
 * never measures an element and hands back only `$el` and `tableApi`. So a
 * density change would repaint every row at its new height while the virtualizer
 * went on placing them at the old one: rows overlapping, the scroll height
 * wrong, and worse the further down you are — at the 100k target the drift is
 * tens of thousands of pixels.
 *
 * Keying the table on the geometry remounts it, and a fresh virtualizer has no
 * measurements to be stale. Guaranteed by Vue's own semantics rather than by a
 * dependency's memo list, which is the point: the alternative — passing a new
 * `getItemKey` identity, which *is* one of those dependencies — works today and
 * would fail silently on the upgrade that reorders them, and silent is the
 * failure mode being prevented.
 *
 * The album header height is in the key too. It has been changeable since W8-3
 * put art size on a control, and it has had this same bug that whole time.
 */
const rowGeometry = computed(() => `${metrics.value.rowPx}:${metrics.value.headerPx}`)

/** The album header's own cell spans the table; the rest of the row is not drawn. */
function isHeaderRow(row: TrackTableRow | undefined): boolean {
  return !!row?.run
}

function groupSubtitle(run: GroupedRun): string {
  const parts: string[] = []
  if (run.group.albumArtist) parts.push(run.group.albumArtist)
  if (run.group.year !== null) parts.push(String(run.group.year))
  parts.push(run.group.trackCount === 1 ? '1 track' : `${run.group.trackCount} tracks`)
  return parts.join(' · ')
}
const layoutKey = computed(() => visibleColumns.value.map((column) => column.key).join())

function tableElement(): HTMLElement | null {
  return table.value?.$el ?? null
}

function requestTrack(index: number): void {
  queueMicrotask(() =>
    props.source.ensureRange(
      Math.max(0, index - OVERSCAN),
      Math.min(props.source.total - 1, index + OVERSCAN)
    )
  )
}

function trackAt(row: TrackTableRow): Track | undefined {
  if (row.index === null) return undefined
  const track = props.source.rowAt(row.index)
  if (!track) requestTrack(row.index)
  return track
}

function formatChannels(channels: number | null): string {
  if (channels === null) return '—'
  if (channels === 1) return 'Mono'
  if (channels === 2) return 'Stereo'
  return `${channels} ch`
}

/**
 * The heart column draws a control, not a value — **D18**.
 *
 * Its own branch in the template rather than a string from `cellText`, and so
 * its own predicate here. Everything else in this table is text with a skeleton
 * behind it while the page loads; this is a button, and a button rendered as a
 * skeleton is one the operator can click before it means anything.
 */
function isFavoriteCell(key: TrackColumnKey): boolean {
  return key === 'favorite'
}

/**
 * The Genre/Tags column draws chips, not a value — **W15-5**.
 *
 * Its own branch for the reason `favorite` has one: the cell is a strip of
 * file-genre and user-tag chips read from the tags store, a projection that is
 * not on the `Track` row at all, so `cellText` has nothing to return for it and
 * the template renders it apart from the ordinary text path.
 */
function isTagsCell(key: TrackColumnKey): boolean {
  return key === 'tags'
}

/**
 * Track ids seen while rendering Tags cells this frame, flushed to the store as
 * one batch.
 *
 * A virtualized list renders its Tags cells as they scroll into view, and
 * fetching each row's tags on its own would be the N+1 the batch endpoint exists
 * to avoid. Collecting the frame's ids and flushing once a microtask later folds
 * a whole page into a single `tags.forTracks`, and the store dedups against its
 * cache and its in-flight set so a stationary list re-rendering asks for nothing.
 */
let pendingTagIds: number[] = []
let tagFlushScheduled = false

function noteTagRow(trackId: number): void {
  pendingTagIds.push(trackId)
  if (tagFlushScheduled) return
  tagFlushScheduled = true
  void queueMicrotask(() => {
    tagFlushScheduled = false
    const ids = pendingTagIds
    pendingTagIds = []
    void tags.ensureTracks(ids)
  })
}

/**
 * A row's two vocabularies from the store, or `undefined` while the batch is
 * still in flight.
 *
 * Reading it is what schedules the fetch, the same shape `trackAt` uses for the
 * page itself: the request follows the render rather than leading it. Returns
 * `undefined` until the id resolves and the batch lands, which the cell draws as
 * a skeleton.
 */
function rowTags(row: TrackTableRow): TrackTagView | undefined {
  const track = trackAt(row)
  if (!track) return undefined
  noteTagRow(track.id)
  return tags.forTrack(track.id)
}

/**
 * The heart's state for a row, or `null` while the page is still loading.
 *
 * Read through the store rather than off `track.favorite`, so a track hearted in
 * NowPlaying — or in another row of this same list, on a library where the same
 * file is indexed once and shown twice — repaints here without the page it came
 * from being fetched again. See `stores/favorites`.
 */
function rowFavorite(row: TrackTableRow): boolean | null {
  const track = trackAt(row)
  return track ? favorites.isFavorite(track) : null
}

function rowFavoriteLabel(row: TrackTableRow): string {
  const track = trackAt(row)
  if (!track) return 'Favorite'
  return favorites.isFavorite(track) ? `Unfavorite ${track.title}` : `Favorite ${track.title}`
}

/**
 * Hearts a row.
 *
 * `.stop` on the handler and nothing else here: the click must not reach the row
 * beneath, which would select it, and a double click on it must not activate the
 * track. A heart is not a way to start playing something.
 */
function onFavoriteClick(row: TrackTableRow): void {
  const track = trackAt(row)
  if (track) void favorites.toggle(track.id)
}

function cellText(row: TrackTableRow, key: TrackColumnKey): string | undefined {
  const track = trackAt(row)
  if (!track) return undefined
  switch (key) {
    // Never reached — the template branches on `isFavoriteCell` before asking
    // for text. Listed so the exhaustive switch stays exhaustive, and returning
    // the empty string rather than a glyph so that a caller who did reach it
    // renders nothing instead of an unclickable heart.
    case 'favorite':
      return ''
    // Never reached either — the template branches on `isTagsCell` first. Listed
    // so the switch stays total over `TrackColumnKey`; the empty string keeps a
    // caller that did reach it drawing nothing rather than a stray glyph.
    case 'tags':
      return ''
    case 'trackNo':
      return track.trackNo === null ? '' : String(track.trackNo)
    case 'title':
      return track.title
    case 'artist':
      return track.artist ?? '—'
    case 'album':
      return track.album ?? '—'
    case 'albumArtist':
      return track.albumArtist ?? '—'
    case 'discNo':
      return track.discNo === null ? '' : String(track.discNo)
    case 'year':
      return track.year === null ? '—' : String(track.year)
    case 'codec':
      return track.codec === null ? '—' : track.codec.toUpperCase()
    case 'durationSec':
      return formats.duration(track.durationSec)
    case 'sampleRateHz':
      return track.sampleRateHz === null ? '—' : `${(track.sampleRateHz / 1000).toFixed(1)} kHz`
    case 'bitDepth':
      return track.bitDepth === null ? '—' : `${track.bitDepth}-bit`
    case 'channels':
      return formatChannels(track.channels)
    case 'encodedBytes':
      return formats.fileSize(track.encodedBytes)
    // Zero is written out rather than dashed, unlike every nullable column
    // above. "Never listened to" is a fact the log is certain about, and a dash
    // would say the opposite — that we do not know. `lastPlayedAt` is the one
    // that genuinely does not know, and gets the dash.
    case 'playCount':
      return String(track.playCount)
    case 'lastPlayedAt':
      return track.lastPlayedAt === null ? '—' : formats.date(track.lastPlayedAt)
  }
}

function cellSlot(key: TrackColumnKey): string {
  return `${key}-cell`
}

function headerSlot(key: TrackColumnKey): string {
  return `${key}-header`
}

function columnName(column: TrackColumnSpec): string {
  return column.title ?? column.label
}

function ariaSort(key: TrackColumnKey): 'ascending' | 'descending' | 'none' {
  if (props.source.sort !== key) return 'none'
  return props.source.direction === 'asc' ? 'ascending' : 'descending'
}

/**
 * Whether a header click re-orders anything.
 *
 * False for the playlist contents pane, where the order is a stored position
 * rather than a column's to change — see `TrackListSource.sort`. Every header
 * then renders as the inert kind, which is the same treatment a column that
 * cannot be sorted has always had here.
 */
const sortable = computed(() => props.source.sort !== null)

function unsortableTitle(column: TrackColumnSpec): string {
  return sortable.value
    ? `${columnName(column)}: this column cannot be sorted`
    : `${columnName(column)}: this list is in its own order`
}

function onTableSelect(event: Event, row: TableRow<TrackTableRow>): void {
  const index = row.original.index
  // Clicking an album header leaves the selection exactly as it was, rather
  // than clearing it the way a click on empty space would.
  if (index === null) return

  const intent = selectionIntent(event instanceof MouseEvent ? event : {})
  void props.source.selectAt(index, intent)

  const track = props.source.rowAt(index)
  if (!track) return
  emit('select', track)
  // A modified double-click is a selection gesture, not a request to play:
  // Ctrl+clicking the same row twice is how an overshot toggle is undone.
  if (intent === 'replace' && event instanceof MouseEvent && event.detail >= 2) {
    emit('activate', track, index)
  }
}

/**
 * Row drag, when the source has any.
 *
 * The handlers hang off the cell wrapper rather than the `tr`, because Nuxt UI
 * renders the row and takes no attributes for it — and the wrapper is bled out
 * over the cell's padding so that there is no strip between columns where a
 * drag would read as having left the row.
 *
 * `dataTransfer` carries a marker and nothing else. What is being dragged is a
 * *selection*, which has no order until main puts one on it, and `dragstart`
 * cannot await; the rows themselves travel beside the drag in `trackDrag.ts`.
 */
function onRowDragStart(index: number | null, event: DragEvent): void {
  if (index === null || props.drag?.enabled !== true || !props.drag.start(index)) {
    event.preventDefault()
    return
  }
  if (event.dataTransfer === null) return
  event.dataTransfer.effectAllowed = 'move'
  // Chromium cancels a drag that carries no payload at all.
  event.dataTransfer.setData('text/plain', String(index))
}

/** Which side of the row's midpoint the pointer fell on decides which edge it drops against. */
function sideOf(event: DragEvent): RowDropSide {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return event.clientY < box.top + box.height / 2 ? 'before' : 'after'
}

function onRowDragOver(index: number | null, event: DragEvent): void {
  // An album header is scenery and cannot be an anchor; the drag falls through
  // to whatever the source makes of a target it has no row for.
  if (props.drag?.over(index, sideOf(event)) !== true) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
}

function onRowDrop(): void {
  props.drag?.drop()
}

function onRowDragEnd(): void {
  props.drag?.end()
}

/**
 * Right-click. The row under the pointer joins the selection first unless it is
 * already in it, which is what makes "act on the selection" and "act on this
 * row" the same verb.
 *
 * Bound on the cell rather than passed as Nuxt UI's `on-contextmenu`, which
 * looks like the obvious home and is not: `UContextMenu` opens by merging its
 * own handler onto the table, `UTable` *declares* `onContextmenu` as a prop, and
 * whichever of the two is written last silently wins. The menu never opened.
 */
const menuIndex = ref<number | null>(null)
/**
 * The event a row already claimed.
 *
 * The table sees the same right-click bubbling up, and without this it could not
 * tell "on a row" from "in the empty space below the last one" — which would
 * offer the previous row's verbs for a click on nothing. Propagation cannot be
 * stopped instead: the menu itself opens from a handler further up.
 */
let claimedContextmenu: Event | null = null

function onRowContextmenu(index: number | null, event: Event): void {
  if (index === null || props.menu === undefined) return
  claimedContextmenu = event
  if (!props.source.isSelectedAt(index)) void props.source.selectAt(index, 'replace')
  menuIndex.value = index
}

function onTableContextmenu(event: Event): void {
  if (event !== claimedContextmenu) menuIndex.value = null
}

const menuItems = computed(() =>
  props.menu === undefined || menuIndex.value === null ? [] : props.menu(menuIndex.value)
)

/**
 * Brings a track offset into view.
 *
 * Takes an offset rather than a display row because that is what the focus
 * model deals in. Headers are taller than tracks, so the pixel position is the
 * rows above times their height plus the headers above times theirs — not
 * `index * rowPx`, which stops being true at the first album boundary.
 */
function scrollIndexIntoView(index: number): void {
  const element = tableElement()
  if (!element) return
  const display = layout.value.displayOf(index)
  const rowPx = metrics.value.rowPx
  const top = displayTopPx(layout.value, display, metrics.value)
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + rowPx > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + rowPx - element.clientHeight
  }
  scrollTop.value = element.scrollTop
}

function onKeydown(event: KeyboardEvent): void {
  // The header owns its own arrows — resize grips are focusable and live inside
  // the same scroll container, so without this a keyboard resize would also walk
  // the selection down the list.
  if (event.target instanceof Element && event.target.closest('thead')) return

  if (event.key === 'Enter') {
    const track = props.source.focusedTrack
    const index = props.source.focusIndex
    if (!track || index === null) return
    event.preventDefault()
    emit('activate', track, index)
    return
  }

  if (event.key === 'Escape') {
    if (props.source.selectionCount === 0) return
    event.preventDefault()
    props.source.clearSelection()
    return
  }

  if (event.key === ' ') {
    if (props.source.focusIndex === null) return
    event.preventDefault()
    props.source.commitFocus(event)
    const track = props.source.focusedTrack
    if (track) emit('select', track)
    return
  }

  const rowsPerPage = Math.max(
    1,
    Math.floor((tableElement()?.clientHeight ?? formats.rowPx) / formats.rowPx)
  )
  const next = props.source.moveFocus(event.key, rowsPerPage, event)
  if (next === null) return
  event.preventDefault()
  requestTrack(next)
  scrollIndexIntoView(next)
  const track = props.source.focusedTrack
  if (track) emit('select', track)
}

/** Column reordering by pointer. Keyboard reordering lives in the chooser. */
const draggingKey = ref<TrackColumnKey | null>(null)
const dropTargetKey = ref<TrackColumnKey | null>(null)

function onDragStart(key: TrackColumnKey, event: DragEvent): void {
  draggingKey.value = key
  event.dataTransfer?.setData('text/plain', key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(key: TrackColumnKey, event: DragEvent): void {
  if (draggingKey.value === null || draggingKey.value === key) return
  event.preventDefault()
  dropTargetKey.value = key
}

function onDrop(key: TrackColumnKey): void {
  const source = draggingKey.value
  draggingKey.value = null
  dropTargetKey.value = null
  if (source === null || source === key) return
  // Which side of the target depends on the direction of travel, so a column
  // dragged rightwards lands after the column it was dropped on rather than
  // stopping one short of it.
  const order = visibleColumns.value.map((column) => column.key)
  columns.moveBefore(source, key, order.indexOf(source) < order.indexOf(key))
}

function onDragEnd(): void {
  draggingKey.value = null
  dropTargetKey.value = null
}

/** Width adjustment. The grip is a focusable separator, so it works either way. */
const resizing = ref<{ key: TrackColumnKey; startX: number; startWidth: number } | null>(null)

function onGripDown(key: TrackColumnKey, event: PointerEvent): void {
  event.preventDefault()
  event.stopPropagation()
  resizing.value = { key, startX: event.clientX, startWidth: columns.widthOf(key) }
  try {
    // Capture keeps the moves coming to the grip once the pointer leaves it,
    // which is most of a drag. It throws for a pointer the browser no longer
    // considers active, and a drag that cannot be captured is still worth
    // starting — it just ends when the pointer leaves the element.
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    // Nothing to recover: `resizing` is set and the move handler is bound.
  }
}

function onGripMove(event: PointerEvent): void {
  const state = resizing.value
  if (!state) return
  // Written on every move; the view store's debounce is what keeps that off the
  // per-frame path. `onGripUp` flushes so the release lands immediately.
  columns.setWidth(state.key, state.startWidth + (event.clientX - state.startX))
}

function onGripUp(): void {
  if (!resizing.value) return
  resizing.value = null
  columns.persist()
}

function onGripKeydown(column: TrackColumnSpec, event: KeyboardEvent): void {
  const step = event.shiftKey ? 1 : WIDTH_STEP
  if (event.key === 'ArrowLeft') columns.nudgeWidth(column.key, -step)
  else if (event.key === 'ArrowRight') columns.nudgeWidth(column.key, step)
  else if (event.key === 'Home') columns.setWidth(column.key, column.minWidth)
  else if (event.key === 'End') columns.setWidth(column.key, column.defaultWidth)
  else return
  event.preventDefault()
  event.stopPropagation()
}

/**
 * The display row at the top, kept current as the list scrolls.
 *
 * Maintained here rather than derived when it is needed, because the moments it
 * is needed — a scroll key changing, an unmount — are moments when `layout` may
 * already describe the list being moved *to*. During a scroll it always
 * describes the list being looked at, so this is the only place the conversion
 * is unambiguous.
 */
let anchorRow = 0

function onScroll(): void {
  scrollTop.value = tableElement()?.scrollTop ?? 0
  anchorRow = displayAtPx(layout.value, scrollTop.value, metrics.value)
}

function restoreScroll(top: number): void {
  scrollTop.value = top
  anchorRow = displayAtPx(layout.value, top, metrics.value)
  const element = tableElement()
  if (element) element.scrollTop = top
}

/** Puts a remembered row back where the current geometry says it belongs. */
function restoreAnchor(display: number): void {
  restoreScroll(displayTopPx(layout.value, display, metrics.value))
}

watch(
  () => props.source.scrollKey,
  async (next, previous) => {
    shell.rememberScroll(previous, anchorRow)
    pendingAnchor = null
    await nextTick()
    restoreAnchor(shell.recallScroll(next))
  }
)

/**
 * The remembered row, applied on the first render that has somewhere to go.
 *
 * Not on mount: the list's total is still zero then, so the virtualizer's
 * scroll height is too and a `scrollTop` written into it is discarded without a
 * sound. This waits for the first page instead, and only fires once.
 *
 * A user who scrolled during that gap has said where they want to be more
 * recently than the last session did, so a container already off zero is left
 * alone.
 */
watch(
  () => props.source.total,
  async (total) => {
    if (pendingAnchor === null || total <= 0) return
    const display = pendingAnchor
    pendingAnchor = null
    await nextTick()
    if ((tableElement()?.scrollTop ?? 0) > 0) return
    restoreAnchor(display)
  },
  { immediate: true }
)

/**
 * Handing the row back on the way out, because there is no scroll event for
 * "unmounted": the container is gone by the time anything could ask it.
 */
onUnmounted(() => {
  shell.rememberScroll(props.source.scrollKey, anchorRow)
})

// Changing the visible columns rebuilds the table, which resets the scroll
// container. Showing a column should not also send the user back to row zero.
watch(layoutKey, async () => {
  const previous = tableElement()?.scrollTop ?? scrollTop.value
  await nextTick()
  restoreScroll(previous)
})

/**
 * A height change keeps the top row, not the top pixel.
 *
 * `anchorRow` is already the row and is already current — this only has to put
 * it back after the remount `rowGeometry` forces, which starts at zero. The one
 * case that is *not* covered here is the common one: the height is changed from
 * the Settings tab, with this list unmounted. That is why the memory holds a row
 * rather than an offset.
 */
watch(metrics, async () => {
  const display = anchorRow
  await nextTick()
  restoreAnchor(display)
})

// A re-sort has moved every row, so the offset means nothing now — including a
// remembered one that has not been applied yet, which would otherwise land on
// top of the reset a moment later.
watch([() => props.source.sort, () => props.source.direction], () => {
  pendingAnchor = null
  restoreScroll(0)
})

onMounted(() => props.source.ensureRange(0, 30))
</script>

<template>
  <UCard
    variant="soft"
    class="h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'h-full min-h-0 p-0 sm:p-0' }"
  >
    <UContextMenu
      :items="menuItems"
      :disabled="menu === undefined"
      :ui="{ content: 'w-56' }"
      class="h-full min-h-0"
    >
      <UTable
        ref="table"
        :key="rowGeometry"
        :data="tableRows"
        :columns="tableColumns"
        :meta="tableMeta"
        :get-row-id="(row: TrackTableRow) => String(row.display)"
        :on-select="onTableSelect"
        :loading="source.loading"
        loading-color="primary"
        loading-animation="carousel"
        sticky="header"
        :virtualize="{ estimateSize: estimateRowSize, overscan: OVERSCAN }"
        :watch-options="{ deep: false }"
        :style="{
          '--oscine-table-width': `${columns.totalWidth}px`,
          '--oscine-row-px': `${metrics.rowPx}px`
        }"
        class="h-full min-h-0 select-none overflow-auto overscroll-contain pb-2 outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-primary"
        :ui="{
          base: 'table-fixed w-[var(--oscine-table-width)] min-w-full',
          thead: 'bg-elevated/75',
          th: 'h-8 px-0 py-0 text-xs font-medium uppercase tracking-wide text-muted',
          tbody: 'divide-y divide-default/60',
          td: 'h-[var(--oscine-row-px)] overflow-hidden px-2 py-0 text-sm last:pe-4',
          tr: 'h-[var(--oscine-row-px)] hover:bg-elevated/70',
          empty: 'h-full p-0'
        }"
        tabindex="0"
        :aria-label="label ?? 'Songs'"
        @scroll.passive="onScroll"
        @keydown="onKeydown"
        @contextmenu="onTableContextmenu"
        @dragover="onRowDragOver(null, $event)"
        @drop.prevent="onRowDrop()"
        @dragend="onRowDragEnd()"
      >
        <template
          v-for="column in visibleColumns"
          :key="headerSlot(column.key)"
          #[headerSlot(column.key)]
        >
          <div
            class="relative flex h-8 items-center"
            :class="{
              'opacity-50': draggingKey === column.key,
              'bg-primary/10': dropTargetKey === column.key
            }"
            draggable="true"
            @dragstart.stop="onDragStart(column.key, $event)"
            @dragover.stop="onDragOver(column.key, $event)"
            @drop.stop.prevent="onDrop(column.key)"
            @dragend.stop="onDragEnd"
          >
            <UTooltip
              v-if="sortable && isSortableColumn(column.key)"
              :text="`Sort by ${columnName(column)}`"
            >
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                class="min-w-0 flex-1 justify-start rounded-none px-2 uppercase"
                :class="alignClass(column)"
                :aria-sort="ariaSort(column.key)"
                @click="source.setSort?.(column.key)"
              >
                <span class="truncate">{{ column.label }}</span>
                <UIcon
                  v-if="source.sort === column.key"
                  :name="
                    source.direction === 'asc' ? 'i-tabler-chevron-up' : 'i-tabler-chevron-down'
                  "
                  class="size-3 shrink-0 text-primary"
                />
              </UButton>
            </UTooltip>
            <UTooltip v-else :text="unsortableTitle(column)">
              <span class="min-w-0 flex-1 truncate px-2" :class="alignClass(column)">
                {{ column.label }}
              </span>
            </UTooltip>

            <!--
            A focusable separator rather than a bare drag affordance: resizing a
            column is not a pointer-only capability, and the window-splitter
            pattern gives it arrow keys for free.
          -->
            <button
              type="button"
              role="separator"
              aria-orientation="vertical"
              :aria-label="`Resize ${columnName(column)} column`"
              :aria-valuenow="columns.widthOf(column.key)"
              :aria-valuemin="column.minWidth"
              :aria-valuemax="800"
              class="absolute inset-y-0 -end-1 z-10 w-2 cursor-col-resize touch-none rounded-none hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none"
              :class="{ 'bg-primary/60': resizing?.key === column.key }"
              @pointerdown="onGripDown(column.key, $event)"
              @pointermove="onGripMove"
              @pointerup="onGripUp"
              @pointercancel="onGripUp"
              @dblclick="columns.setWidth(column.key, column.defaultWidth)"
              @keydown="onGripKeydown(column, $event)"
            />
          </div>
        </template>

        <template
          v-for="column in visibleColumns"
          :key="cellSlot(column.key)"
          #[cellSlot(column.key)]="{ row }"
        >
          <!--
          The cell's whole area, bled back out over the `td` padding so that a
          drag crossing a column edge never leaves the row it is over.
        -->
          <div
            class="-mx-2 flex h-full items-center px-2"
            :draggable="drag?.enabled === true && row.original.index !== null"
            @contextmenu="onRowContextmenu(row.original.index, $event)"
            @dragstart.stop="onRowDragStart(row.original.index, $event)"
            @dragover.stop="onRowDragOver(row.original.index, $event)"
            @drop.stop.prevent="onRowDrop()"
            @dragend.stop="onRowDragEnd()"
          >
            <!--
            The album header. Only the leading column renders it; the others are
            hidden on this row so the column span has the width to itself.
          -->
            <!--
            The leading column only. The guard used to sit on the sleeve and the
            title, which left every other column of a header row rendering its
            own copy of the section — four invisible, zero-width duplicates of
            the actions button, each one focusable by a screen reader and by
            Tab. One header row, one section, one button.
          -->
            <template v-if="row.original.run">
              <section
                v-if="column.key === leadingColumnKey"
                class="flex w-full items-center justify-between"
              >
                <div class="flex items-center gap-3 py-1">
                  <img
                    :src="row.original.run.group.artwork.small"
                    alt=""
                    aria-hidden="true"
                    class="shrink-0 rounded bg-elevated object-cover"
                    :style="{ width: `${grouping.artPx}px`, height: `${grouping.artPx}px` }"
                    loading="lazy"
                    draggable="false"
                  />
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium text-highlighted">
                      {{ row.original.run.group.title ?? 'Unknown album' }}
                    </span>
                    <span class="block truncate text-xs text-muted">
                      {{ groupSubtitle(row.original.run) }}
                    </span>
                  </span>
                </div>
                <UDropdownMenu
                  v-if="groupMenu"
                  :items="groupMenu(row.original.run)"
                  :ui="{ content: 'w-60' }"
                >
                  <UButton
                    variant="ghost"
                    color="neutral"
                    icon="i-tabler-dots-vertical-filled"
                    :aria-label="`Actions for ${row.original.run.group.title ?? 'Unknown album'}`"
                    @click.stop
                    @dblclick.stop
                  />
                </UDropdownMenu>
              </section>
            </template>
            <template v-else>
              <!--
              The playing glyph, in the leading column whichever column that is.
              It sits beside the value rather than replacing it — a numeric
              leading column is right-aligned, so the glyph takes the space at
              the start that the digits were never using, and no column loses
              the thing it exists to show.
            -->
              <span
                v-if="cellMark(row.original, column.key) !== null"
                class="me-1.5 inline-flex shrink-0 items-center"
              >
                <UIcon
                  :name="nowPlayingIcon(cellMark(row.original, column.key))"
                  class="size-3 text-primary"
                  aria-hidden="true"
                />
                <span class="sr-only">{{
                  nowPlayingLabel(cellMark(row.original, column.key))
                }}</span>
              </span>
              <!--
              The "edited, not yet written" mark (W16): a track carrying an
              unwritten correction shows one dot at the head of the row. The
              Tools → Tag write-back tool is where these are flushed to disk.
            -->
              <span
                v-if="cellModified(row.original, column.key)"
                class="me-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle"
                title="Edited — not yet written to the file"
                aria-label="Modified"
              />
              <!--
              The heart, which is a control rather than a value and so gets its
              own branch. Nothing is drawn until the page arrives — a skeleton
              here would be a button the operator could click before it stood
              for a track.

              `aria-pressed` rather than a label that changes shape: this is a
              two-state toggle, and the accessible name naming the track is what
              makes a column of forty identical hearts navigable.
            -->
              <button
                v-if="isFavoriteCell(column.key)"
                v-show="rowFavorite(row.original) !== null"
                type="button"
                class="mx-auto flex size-6 items-center justify-center rounded hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                :aria-pressed="rowFavorite(row.original) === true"
                :aria-label="rowFavoriteLabel(row.original)"
                @click.stop="onFavoriteClick(row.original)"
                @dblclick.stop
              >
                <UIcon
                  :name="rowFavorite(row.original) ? 'i-tabler-heart-filled' : 'i-tabler-heart'"
                  class="size-4"
                  :class="rowFavorite(row.original) ? 'text-primary' : 'text-dimmed'"
                  aria-hidden="true"
                />
              </button>
              <!--
                Genre/Tags — a strip of chips rather than a value (W15-5). File
                genres are muted with a file glyph, matching the deck Tags pane's
                "From the file"; the operator's own tags carry the primary tint.
                One `v-for` over a single-element array so `rowTags` — which
                schedules the fetch — is called once per cell, and the strip is
                clipped to the column width rather than wrapping the row taller.
              -->
              <template v-else-if="isTagsCell(column.key)">
                <template v-for="(view, viewIndex) in [rowTags(row.original)]" :key="viewIndex">
                  <USkeleton v-if="view === undefined" class="h-2 w-24 max-w-full" />
                  <span
                    v-else-if="view.file.length === 0 && view.user.length === 0"
                    class="text-dimmed"
                  >
                    —
                  </span>
                  <div v-else class="flex w-full items-center gap-1 overflow-hidden">
                    <span
                      v-for="genre in view.file"
                      :key="`g:${genre}`"
                      class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-elevated/50 px-1.5 py-0.5 text-xs text-muted"
                      :title="`“${genre}” — from the file’s tag.`"
                    >
                      <UIcon
                        name="i-tabler-file-music"
                        class="size-3 shrink-0 text-dimmed"
                        aria-hidden="true"
                      />
                      {{ genre }}
                    </span>
                    <span
                      v-for="tag in view.user"
                      :key="`u:${tag.id}`"
                      class="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-default"
                      :title="`“${tag.label}” — your tag.`"
                    >
                      {{ tag.label }}
                    </span>
                  </div>
                </template>
              </template>
              <USkeleton
                v-else-if="cellText(row.original, column.key) === undefined"
                class="h-2 w-24 max-w-full"
              />
              <span v-else class="block w-full truncate">
                {{ cellText(row.original, column.key) }}
              </span>
            </template>
          </div>
        </template>

        <template #empty>
          <!--
          Whose emptiness it is depends on the list, so the wording comes from
          above rather than from a component that no longer knows which of the
          two it is drawing.
        -->
          <slot name="empty">
            <UEmpty
              variant="naked"
              icon="i-tabler-playlist"
              title="No tracks yet"
              description="Add a folder to index music, or change the active filters."
              class="h-full"
            />
          </slot>
        </template>
      </UTable>
    </UContextMenu>
  </UCard>
</template>
