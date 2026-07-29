<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { TableColumn, TableRow } from '@nuxt/ui'
import { useTrackListStore } from '@renderer/stores/trackList'
import type { Track, TrackSortColumn } from '@shared/library'

const emit = defineEmits<{
  select: [track: Track]
  activate: [track: Track, index: number]
}>()

const panel = useTrackListStore()
const ROW_HEIGHT = 32
const OVERSCAN = 8

interface TrackTableRow {
  index: number
}

interface ColumnSpec {
  key: TrackSortColumn
  label: string
  align: string
  width?: string
}

const COLUMNS: readonly ColumnSpec[] = [
  { key: 'trackNo', label: '#', align: 'text-right tabular-nums text-dimmed', width: '3rem' },
  { key: 'title', label: 'Title', align: 'text-highlighted' },
  { key: 'artist', label: 'Artist', align: 'text-muted' },
  { key: 'album', label: 'Album', align: 'text-muted' },
  {
    key: 'durationSec',
    label: 'Time',
    align: 'text-right tabular-nums text-muted',
    width: '4rem'
  }
]

const columns: TableColumn<TrackTableRow>[] = COLUMNS.map((column) => ({
  id: column.key,
  header: column.label,
  accessorFn: (row) => row.index,
  meta: {
    class: {
      th: column.align,
      td: column.align
    },
    ...(column.width
      ? {
          style: {
            th: { width: column.width },
            td: { width: column.width }
          }
        }
      : {})
  }
}))

const table = ref<{ $el?: HTMLElement } | null>(null)
const scrollTop = ref(0)
const scrollPositions = new Map<string, number>()

const tableRows = computed<TrackTableRow[]>(() => {
  void panel.ordering
  return Array.from({ length: panel.total }, (_, index) => ({ index }))
})
const rowSelection = computed<Record<string, boolean>>({
  get: () => (panel.selectedIndex === null ? {} : { [String(panel.selectedIndex)]: true }),
  set: (selection) => {
    const selected = Object.keys(selection).find((key) => selection[key])
    if (selected !== undefined) panel.select(Number(selected))
  }
})
const filterKey = computed(() => JSON.stringify(panel.filters))

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

function cellText(row: TrackTableRow, key: TrackSortColumn): string | undefined {
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
    case 'durationSec':
      return formatDuration(track.durationSec)
  }
}

function cellSlot(key: TrackSortColumn): string {
  return `${key}-cell`
}

function headerSlot(key: TrackSortColumn): string {
  return `${key}-header`
}

function ariaSort(column: TrackSortColumn): 'ascending' | 'descending' | 'none' {
  if (panel.sort !== column) return 'none'
  return panel.direction === 'asc' ? 'ascending' : 'descending'
}

function onTableSelect(event: Event, row: TableRow<TrackTableRow>): void {
  const index = row.original.index
  panel.select(index)
  const track = panel.rowAt(index)
  if (!track) return
  emit('select', track)
  if (event instanceof MouseEvent && event.detail >= 2) emit('activate', track, index)
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
  if (event.key === 'Enter') {
    const track = panel.selectedTrack
    const index = panel.selectedIndex
    if (!track || index === null) return
    event.preventDefault()
    emit('activate', track, index)
    return
  }

  const rowsPerPage = Math.max(
    1,
    Math.floor((tableElement()?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT)
  )
  const next = panel.moveSelection(event.key, rowsPerPage)
  if (next === null) return
  event.preventDefault()
  requestTrack(next)
  scrollIndexIntoView(next)
  const track = panel.selectedTrack
  if (track) emit('select', track)
}

watch(filterKey, async (next, previous) => {
  scrollPositions.set(previous, tableElement()?.scrollTop ?? scrollTop.value)
  await nextTick()
  const restored = scrollPositions.get(next) ?? 0
  scrollTop.value = restored
  if (tableElement()) tableElement()!.scrollTop = restored
})
watch([() => panel.sort, () => panel.direction], () => {
  scrollTop.value = 0
  if (tableElement()) tableElement()!.scrollTop = 0
})

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
      v-model:row-selection="rowSelection"
      :data="tableRows"
      :columns="columns"
      :get-row-id="(row: TrackTableRow) => String(row.index)"
      :on-select="onTableSelect"
      :loading="panel.loading"
      loading-color="primary"
      loading-animation="carousel"
      sticky="header"
      :virtualize="{ estimateSize: ROW_HEIGHT, overscan: OVERSCAN }"
      :watch-options="{ deep: false }"
      class="h-full min-h-0 overflow-auto overscroll-contain pb-2 outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-primary"
      :ui="{
        base: 'table-fixed',
        thead: 'bg-elevated/95',
        th: 'h-8 px-2 py-0 text-xs font-medium uppercase tracking-wide text-muted',
        tbody: 'divide-y divide-default/60',
        td: 'h-8 overflow-hidden px-2 py-0 text-sm last:pe-4',
        tr: 'h-8 data-[selected=true]:bg-primary/15 hover:bg-elevated/70',
        empty: 'h-full p-0'
      }"
      tabindex="0"
      aria-label="Songs"
      @scroll.passive="scrollTop = tableElement()?.scrollTop ?? 0"
      @keydown="onKeydown"
    >
      <template v-for="column in COLUMNS" :key="headerSlot(column.key)" #[headerSlot(column.key)]>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          class="-mx-2 w-[calc(100%+1rem)] justify-start rounded-none px-2 uppercase"
          :class="column.align"
          :aria-sort="ariaSort(column.key)"
          @click="panel.setSort(column.key)"
        >
          <span class="truncate">{{ column.label }}</span>
          <UIcon
            v-if="panel.sort === column.key"
            :name="panel.direction === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            class="size-3 shrink-0 text-primary"
          />
        </UButton>
      </template>

      <template
        v-for="column in COLUMNS"
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
