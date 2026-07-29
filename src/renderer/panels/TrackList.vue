<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useTrackListStore } from '@renderer/stores/trackList'
import type { Track, TrackSortColumn } from '@shared/library'

/**
 * The track list island (D4).
 *
 * It renders itself from its own store and knows nothing about what sits
 * beside it. The only things that cross its edge are two events — a row was
 * selected, a row was activated — so a host can wire playback, and a docking
 * system can move this panel later without touching what is inside it.
 *
 * Virtualized from the first commit: the DOM holds one screen of rows plus a
 * little overscan whether the library has fifty tracks or a hundred thousand,
 * and the spacer below carries the scrollbar. Sorting is a query parameter, not
 * an operation on anything held here — see `trackWindow.ts`.
 */

const emit = defineEmits<{
  select: [track: Track]
  /**
   * The row index rides along because it is the coordinate play order is
   * expressed in. Letting the host read it back off the selection instead would
   * work only for as long as activation always follows a click, which the Enter
   * key already makes untrue.
   */
  activate: [track: Track, index: number]
}>()

const panel = useTrackListStore()

/**
 * Row height in pixels, fixed.
 *
 * Declared here rather than in CSS because the scroll arithmetic needs the
 * number, and two declarations that must agree are one refactor away from
 * disagreeing. The template binds its rows to this value.
 */
const ROW_HEIGHT = 32

/** Rows rendered beyond each edge, so a fast flick does not expose blank space. */
const OVERSCAN = 6

interface Column {
  key: TrackSortColumn
  label: string
  /** Column-specific cell classes: alignment and emphasis only, never colour values. */
  cell: string
  header: string
}

const COLUMNS: readonly Column[] = [
  {
    key: 'trackNo',
    label: '#',
    cell: 'justify-end tabular-nums text-dimmed',
    header: 'justify-end'
  },
  { key: 'title', label: 'Title', cell: 'text-highlighted', header: '' },
  { key: 'artist', label: 'Artist', cell: 'text-muted', header: '' },
  { key: 'album', label: 'Album', cell: 'text-muted', header: '' },
  {
    key: 'durationSec',
    label: 'Time',
    cell: 'justify-end tabular-nums text-muted',
    header: 'justify-end'
  }
]

const GRID_TEMPLATE = '3rem minmax(8rem, 2.2fr) minmax(6rem, 1.3fr) minmax(6rem, 1.3fr) 4rem'

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)

const rowsPerViewport = computed(() => Math.max(1, Math.ceil(viewportHeight.value / ROW_HEIGHT)))
const totalHeight = computed(() => panel.total * ROW_HEIGHT)

const firstIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN))
const lastIndex = computed(() =>
  Math.min(panel.total - 1, firstIndex.value + rowsPerViewport.value + OVERSCAN * 2)
)
const offsetY = computed(() => firstIndex.value * ROW_HEIGHT)

/**
 * The rows actually mounted. Length is bounded by the viewport, not by `total` —
 * that bound is the whole point of this panel.
 */
const renderedRows = computed(() => {
  const rows: Array<{ index: number; track: Track | undefined }> = []
  for (let index = firstIndex.value; index <= lastIndex.value; index++) {
    rows.push({ index, track: panel.rowAt(index) })
  }
  return rows
})

const isEmpty = computed(() => panel.total === 0 && !panel.loading)

watch([firstIndex, lastIndex], ([first, last]) => panel.ensureRange(first, Math.max(first, last)), {
  immediate: true
})

// A re-sort renumbers every row, so the old scroll offset points at unrelated
// music. Returning to the top is the only position that still means something.
watch(
  () => panel.ordering,
  () => {
    scrollTop.value = 0
    if (scroller.value) scroller.value.scrollTop = 0
  }
)

function onScroll(): void {
  scrollTop.value = scroller.value?.scrollTop ?? 0
}

function scrollIndexIntoView(index: number): void {
  const el = scroller.value
  if (!el) return

  const top = index * ROW_HEIGHT
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
    el.scrollTop = top + ROW_HEIGHT - el.clientHeight
  }
  // `scroll` fires asynchronously; the derived range must not lag a keypress.
  scrollTop.value = el.scrollTop
}

function onRowClick(index: number): void {
  panel.select(index)
  const track = panel.rowAt(index)
  if (track) emit('select', track)
}

function onRowActivate(index: number): void {
  const track = panel.rowAt(index)
  if (track) emit('activate', track, index)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    const track = panel.selectedTrack
    const index = panel.selectedIndex
    if (!track || index === null) return
    event.preventDefault()
    emit('activate', track, index)
    return
  }

  const next = panel.moveSelection(event.key, rowsPerViewport.value)
  if (next === null) return

  event.preventDefault()
  scrollIndexIntoView(next)
  // Silent when the row has not arrived yet; the host would have nothing to do
  // with a half-known selection, and the next page load fills it in.
  const track = panel.selectedTrack
  if (track) emit('select', track)
}

function ariaSort(column: TrackSortColumn): 'ascending' | 'descending' | 'none' {
  if (panel.sort !== column) return 'none'
  return panel.direction === 'asc' ? 'ascending' : 'descending'
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function cellText(track: Track, key: TrackSortColumn): string {
  switch (key) {
    case 'trackNo':
      return track.trackNo === null ? '' : String(track.trackNo)
    case 'title':
      return track.title
    case 'artist':
      return track.artist ?? '—'
    case 'album':
      return track.album ?? '—'
    case 'durationSec':
      return formatDuration(track.durationSec)
  }
}

let observer: ResizeObserver | null = null

onMounted(() => {
  const el = scroller.value
  if (!el) return

  const measure = (): void => {
    viewportHeight.value = el.clientHeight
  }
  measure()
  // The panel is sized by its host, which may not have laid out yet and will
  // resize again the moment a docking system arrives.
  observer = new ResizeObserver(measure)
  observer.observe(el)
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-default bg-default"
    role="grid"
    :aria-rowcount="panel.total"
  >
    <div
      class="grid shrink-0 items-center border-b border-default bg-elevated"
      :style="{ gridTemplateColumns: GRID_TEMPLATE, height: `${ROW_HEIGHT}px` }"
      role="row"
    >
      <button
        v-for="column in COLUMNS"
        :key="column.key"
        type="button"
        role="columnheader"
        :aria-sort="ariaSort(column.key)"
        class="flex h-full items-center gap-1 px-2 text-xs font-medium uppercase tracking-wide text-muted transition-colors hover:text-highlighted"
        :class="column.header"
        @click="panel.setSort(column.key)"
      >
        <span class="truncate">{{ column.label }}</span>
        <UIcon
          v-if="panel.sort === column.key"
          :name="panel.direction === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          class="size-3 shrink-0 text-primary"
        />
      </button>
    </div>

    <UAlert
      v-if="panel.error"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="panel.error"
      class="rounded-none"
    />

    <!-- tabindex makes the list itself the keyboard target: arrows, Home and
         End belong to the list, not to a focused row that virtualization would
         unmount out from under the focus ring. -->
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-primary"
      tabindex="0"
      @scroll.passive="onScroll"
      @keydown="onKeydown"
    >
      <div v-if="isEmpty" class="flex h-full items-center justify-center p-6 text-sm text-muted">
        No tracks yet. Add a folder to index one.
      </div>

      <div v-else class="relative w-full" :style="{ height: `${totalHeight}px` }">
        <div class="absolute inset-x-0 top-0" :style="{ transform: `translateY(${offsetY}px)` }">
          <div
            v-for="row in renderedRows"
            :key="row.index"
            role="row"
            :aria-rowindex="row.index + 1"
            :aria-selected="panel.selectedIndex === row.index"
            class="grid cursor-default items-center text-sm"
            :class="
              panel.selectedIndex === row.index
                ? 'bg-primary/10 text-highlighted'
                : 'hover:bg-elevated'
            "
            :style="{ gridTemplateColumns: GRID_TEMPLATE, height: `${ROW_HEIGHT}px` }"
            @click="onRowClick(row.index)"
            @dblclick="onRowActivate(row.index)"
          >
            <template v-if="row.track">
              <div
                v-for="column in COLUMNS"
                :key="column.key"
                role="gridcell"
                class="flex items-center overflow-hidden px-2"
                :class="column.cell"
              >
                <span class="truncate">{{ cellText(row.track, column.key) }}</span>
              </div>
            </template>

            <!-- The page covering this row is still in flight. A placeholder
                 keeps the row height stable so the scrollbar does not jump. -->
            <div v-else class="col-span-5 flex items-center px-2">
              <span class="h-2 w-40 max-w-[40%] animate-pulse rounded bg-elevated" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
