<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { TableColumn, TableRow } from '@nuxt/ui'
import {
  isSortableColumn,
  type TrackColumnKey,
  type TrackColumnSpec
} from '@renderer/panels/columnLayout'
import { selectionIntent } from '@renderer/panels/trackSelection'
import { useTrackColumnsStore } from '@renderer/stores/columns'
import { useTrackListStore } from '@renderer/stores/trackList'
import type { Track } from '@shared/library'

/**
 * The virtualized song list.
 *
 * Two things are deliberately not delegated to Nuxt UI here, and both for the
 * same reason — the component is virtualizing 100k rows and neither feature can
 * be expressed against rows it has not mounted.
 *
 * Selection does not use `v-model:row-selection`. TanStack's selection state is
 * a map keyed by row id, which for us is a *position*; feeding it our id-based
 * selection would mean holding a position for every selected row and rebuilding
 * an object of them on every click, and it would still be wrong the moment a
 * re-sort moved the rows. Rows are styled from `panel.isSelectedAt` instead,
 * which asks the loaded row for its id and tests set membership — correct after
 * a re-sort, and costing nothing for the 99% of the library that is not mounted.
 *
 * Column widths are ours too, because Nuxt UI applies `meta.style`, not
 * TanStack's `columnSizing`, to the DOM. Since the widths have to be persisted
 * anyway, one source of truth in `columnLayout` is simpler than two.
 */

const emit = defineEmits<{
  select: [track: Track]
  activate: [track: Track, index: number]
}>()

const panel = useTrackListStore()
const columns = useTrackColumnsStore()
const ROW_HEIGHT = 32
const OVERSCAN = 8
/** Pixels an arrow key moves a column edge. Shift narrows it to one. */
const WIDTH_STEP = 16

interface TrackTableRow {
  index: number
}

const visibleColumns = computed(() => columns.visibleColumns)

function alignClass(column: TrackColumnSpec): string {
  const tone =
    column.key === 'title'
      ? 'text-highlighted'
      : column.key === 'trackNo'
        ? 'text-dimmed'
        : 'text-muted'
  return column.numeric ? `text-right tabular-nums ${tone}` : tone
}

const tableColumns = computed<TableColumn<TrackTableRow>[]>(() =>
  visibleColumns.value.map((column) => {
    const width = `${columns.widthOf(column.key)}px`
    return {
      id: column.key,
      header: column.label,
      accessorFn: (row: TrackTableRow) => row.index,
      meta: {
        class: { th: alignClass(column), td: alignClass(column) },
        style: { th: { width }, td: { width } }
      }
    }
  })
)

/**
 * Per-row classes.
 *
 * Passed as table `meta` because that is the only hook Nuxt UI resolves against
 * an individual row. Selection, keyboard focus and the range anchor are three
 * separate states and all three are shown: a user building a disjoint selection
 * has to be able to see where the next Shift+click will measure from.
 */
const tableMeta = computed(() => ({
  class: {
    tr: (row: TableRow<TrackTableRow>) => {
      const index = row.original.index
      const classes: string[] = []
      if (panel.isSelectedAt(index)) classes.push('bg-primary/15')
      if (panel.anchorIndex === index) classes.push('border-s-2 border-s-primary')
      if (panel.focusIndex === index) classes.push('ring-1 ring-inset ring-primary/70')
      return classes.join(' ')
    }
  }
}))

const table = ref<{ $el?: HTMLElement } | null>(null)
const scrollTop = ref(0)
const scrollPositions = new Map<string, number>()

const tableRows = computed<TrackTableRow[]>(() => {
  void panel.ordering
  return Array.from({ length: panel.total }, (_, index) => ({ index }))
})
const filterKey = computed(() => JSON.stringify(panel.filters))
const layoutKey = computed(() => visibleColumns.value.map((column) => column.key).join())

function tableElement(): HTMLElement | null {
  return table.value?.$el ?? null
}

function requestTrack(index: number): void {
  queueMicrotask(() =>
    panel.ensureRange(Math.max(0, index - OVERSCAN), Math.min(panel.total - 1, index + OVERSCAN))
  )
}

function trackAt(row: TrackTableRow): Track | undefined {
  const track = panel.rowAt(row.index)
  if (!track) requestTrack(row.index)
  return track
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function formatChannels(channels: number | null): string {
  if (channels === null) return '—'
  if (channels === 1) return 'Mono'
  if (channels === 2) return 'Stereo'
  return `${channels} ch`
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024
  return mib < 10 ? `${mib.toFixed(1)} MB` : `${Math.round(mib)} MB`
}

function cellText(row: TrackTableRow, key: TrackColumnKey): string | undefined {
  const track = trackAt(row)
  if (!track) return undefined
  switch (key) {
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
      return formatDuration(track.durationSec)
    case 'sampleRateHz':
      return track.sampleRateHz === null ? '—' : `${(track.sampleRateHz / 1000).toFixed(1)} kHz`
    case 'bitDepth':
      return track.bitDepth === null ? '—' : `${track.bitDepth}-bit`
    case 'channels':
      return formatChannels(track.channels)
    case 'encodedBytes':
      return formatBytes(track.encodedBytes)
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
  if (panel.sort !== key) return 'none'
  return panel.direction === 'asc' ? 'ascending' : 'descending'
}

function onTableSelect(event: Event, row: TableRow<TrackTableRow>): void {
  const index = row.original.index
  const intent = selectionIntent(event instanceof MouseEvent ? event : {})
  void panel.selectAt(index, intent)

  const track = panel.rowAt(index)
  if (!track) return
  emit('select', track)
  // A modified double-click is a selection gesture, not a request to play:
  // Ctrl+clicking the same row twice is how an overshot toggle is undone.
  if (intent === 'replace' && event instanceof MouseEvent && event.detail >= 2) {
    emit('activate', track, index)
  }
}

function scrollIndexIntoView(index: number): void {
  const element = tableElement()
  if (!element) return
  const top = index * ROW_HEIGHT
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  }
  scrollTop.value = element.scrollTop
}

function onKeydown(event: KeyboardEvent): void {
  // The header owns its own arrows — resize grips are focusable and live inside
  // the same scroll container, so without this a keyboard resize would also walk
  // the selection down the list.
  if (event.target instanceof Element && event.target.closest('thead')) return

  if (event.key === 'Enter') {
    const track = panel.focusedTrack
    const index = panel.focusIndex
    if (!track || index === null) return
    event.preventDefault()
    emit('activate', track, index)
    return
  }

  if (event.key === 'Escape') {
    if (panel.selectionCount === 0) return
    event.preventDefault()
    panel.clearSelection()
    return
  }

  if (event.key === ' ') {
    if (panel.focusIndex === null) return
    event.preventDefault()
    panel.commitFocus(event)
    const track = panel.focusedTrack
    if (track) emit('select', track)
    return
  }

  const rowsPerPage = Math.max(
    1,
    Math.floor((tableElement()?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT)
  )
  const next = panel.moveFocus(event.key, rowsPerPage, event)
  if (next === null) return
  event.preventDefault()
  requestTrack(next)
  scrollIndexIntoView(next)
  const track = panel.focusedTrack
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
  // Not persisted per move — the layout is written once, on release.
  columns.setWidth(state.key, state.startWidth + (event.clientX - state.startX), {
    persist: false
  })
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

function restoreScroll(top: number): void {
  scrollTop.value = top
  const element = tableElement()
  if (element) element.scrollTop = top
}

watch(filterKey, async (next, previous) => {
  scrollPositions.set(previous, tableElement()?.scrollTop ?? scrollTop.value)
  await nextTick()
  restoreScroll(scrollPositions.get(next) ?? 0)
})

// Changing the visible columns rebuilds the table, which resets the scroll
// container. Showing a column should not also send the user back to row zero.
watch(layoutKey, async () => {
  const previous = tableElement()?.scrollTop ?? scrollTop.value
  await nextTick()
  restoreScroll(previous)
})

watch([() => panel.sort, () => panel.direction], () => restoreScroll(0))

onMounted(() => panel.ensureRange(0, 30))
</script>

<template>
  <UCard
    variant="soft"
    class="h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'h-full min-h-0 p-0 sm:p-0' }"
  >
    <UTable
      ref="table"
      :data="tableRows"
      :columns="tableColumns"
      :meta="tableMeta"
      :get-row-id="(row: TrackTableRow) => String(row.index)"
      :on-select="onTableSelect"
      :loading="panel.loading"
      loading-color="primary"
      loading-animation="carousel"
      sticky="header"
      :virtualize="{ estimateSize: ROW_HEIGHT, overscan: OVERSCAN }"
      :watch-options="{ deep: false }"
      :style="{ '--fermata-table-width': `${columns.totalWidth}px` }"
      class="h-full min-h-0 select-none overflow-auto overscroll-contain pb-2 outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-primary"
      :ui="{
        base: 'table-fixed w-[var(--fermata-table-width)] min-w-full',
        thead: 'bg-elevated/95',
        th: 'h-8 px-0 py-0 text-xs font-medium uppercase tracking-wide text-muted',
        tbody: 'divide-y divide-default/60',
        td: 'h-8 overflow-hidden px-2 py-0 text-sm last:pe-4',
        tr: 'h-8 hover:bg-elevated/70',
        empty: 'h-full p-0'
      }"
      tabindex="0"
      aria-label="Songs"
      @scroll.passive="scrollTop = tableElement()?.scrollTop ?? 0"
      @keydown="onKeydown"
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
          @dragstart="onDragStart(column.key, $event)"
          @dragover="onDragOver(column.key, $event)"
          @drop.prevent="onDrop(column.key)"
          @dragend="onDragEnd"
        >
          <UButton
            v-if="isSortableColumn(column.key)"
            color="neutral"
            variant="ghost"
            size="xs"
            class="min-w-0 flex-1 justify-start rounded-none px-2 uppercase"
            :class="alignClass(column)"
            :aria-sort="ariaSort(column.key)"
            :title="`Sort by ${columnName(column)}`"
            @click="panel.setSort(column.key)"
          >
            <span class="truncate">{{ column.label }}</span>
            <UIcon
              v-if="panel.sort === column.key"
              :name="panel.direction === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-3 shrink-0 text-primary"
            />
          </UButton>
          <span
            v-else
            class="min-w-0 flex-1 truncate px-2"
            :class="alignClass(column)"
            :title="`${columnName(column)} — this column cannot be sorted`"
          >
            {{ column.label }}
          </span>

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
        <USkeleton
          v-if="cellText(row.original, column.key) === undefined"
          class="h-2 w-24 max-w-full"
        />
        <span v-else class="block truncate">{{ cellText(row.original, column.key) }}</span>
      </template>

      <template #empty>
        <UEmpty
          variant="naked"
          icon="i-lucide-list-music"
          title="No tracks yet"
          description="Add a folder to index music, or change the active filters."
          class="h-full"
        />
      </template>
    </UTable>
  </UCard>
</template>
