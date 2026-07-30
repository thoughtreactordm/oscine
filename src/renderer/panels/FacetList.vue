<script setup lang="ts" generic="T extends { id: number }">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { selectionIntent } from '@renderer/panels/indexedSelection'
import type { FacetWindow } from '@renderer/panels/facetWindow'

/**
 * A virtualized, multi-selectable facet pane.
 *
 * Hand-rolled rather than a `UListbox`, and the reason is the selection: a
 * listbox's `multiple` mode is toggle-on-click, with no anchor and no notion of
 * a range, so Shift+click over 4,000 artists would either do nothing or select
 * one row. Driving `UListbox` and *also* maintaining the real selection beside it
 * would mean two disagreeing sources of truth for what is highlighted.
 *
 * The virtualization is a windowed slice rather than a measuring virtualizer
 * because every row here is exactly `rowHeight` tall. That makes the arithmetic
 * total, not estimated: the spacer is `total * rowHeight`, the first visible row
 * is `scrollTop / rowHeight`, and no row needs measuring before it can be placed.
 *
 * An island in the sense the conventions mean it: it knows about a facet window
 * and nothing about the other panes, which is what lets both facets be one
 * component rather than two that drift.
 */
const props = defineProps<{
  model: FacetWindow<T>
  rowHeight: number
  label: string
  /** Rows rendered beyond the viewport, absorbing fast scrolls. */
  overscan?: number
}>()

const emit = defineEmits<{
  /** A row was activated — double-clicked or Enter. */
  activate: [item: T, index: number]
}>()

const OVERSCAN_DEFAULT = 8

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)

const overscan = computed(() => props.overscan ?? OVERSCAN_DEFAULT)
const rowsPerPage = computed(() =>
  Math.max(1, Math.floor(viewportHeight.value / props.rowHeight) || 1)
)

/**
 * The slice to render, in facet index space.
 *
 * Clamped to the total rather than to what is loaded: an index whose page has
 * not arrived still gets a row, because a hole in the list would make the
 * scrollbar lie about how much there is.
 */
const visible = computed(() => {
  const total = props.model.total.value
  if (total === 0) return { first: 0, last: -1 }
  const firstVisible = Math.floor(scrollTop.value / props.rowHeight)
  const first = Math.max(0, firstVisible - overscan.value)
  const last = Math.min(total - 1, firstVisible + rowsPerPage.value + overscan.value)
  return { first, last }
})

const rows = computed(() => {
  const { first, last } = visible.value
  const out: Array<{ index: number; item: T | undefined }> = []
  for (let index = first; index <= last; index++)
    out.push({ index, item: props.model.rowAt(index) })
  return out
})

// Asking for the slice is a side effect of rendering it, so the request follows
// the render rather than leading it — the same shape the track list uses.
watch(
  visible,
  ({ first, last }) => {
    if (last >= first) props.model.ensureRange(first, last)
  },
  { immediate: true, flush: 'post' }
)

function measure(): void {
  const element = viewport.value
  if (!element) return
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight
}

/**
 * The height has to be observed, not read once.
 *
 * Both panes share a resizable sidebar and split the space between them, so the
 * viewport changes size without ever scrolling — and an unmeasured viewport
 * reports a height of zero, which would render a single row and leave the rest
 * of the pane blank.
 */
let observer: ResizeObserver | null = null

onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (viewport.value) observer.observe(viewport.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

/** Keeps a keyboard-moved focus on screen without disturbing a mouse scroll. */
function scrollIndexIntoView(index: number): void {
  const element = viewport.value
  if (!element) return
  const top = index * props.rowHeight
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + props.rowHeight > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + props.rowHeight - element.clientHeight
  }
  scrollTop.value = element.scrollTop
}

function onRowPointerDown(index: number, event: MouseEvent): void {
  // Selection commits on pointer-down, matching every other list the user has
  // used: waiting for the click means a Shift-drag starts from the wrong row.
  const intent = selectionIntent(event)
  void props.model.select(index, intent)
}

function onRowDoubleClick(index: number, event: MouseEvent): void {
  // A modified double-click is a selection gesture, not an activation:
  // Ctrl+clicking the same row twice is how an overshot toggle is undone.
  if (selectionIntent(event) !== 'replace') return
  const item = props.model.rowAt(index)
  if (item) emit('activate', item, index)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (props.model.selectionCount.value === 0) return
    event.preventDefault()
    props.model.clearSelection()
    return
  }

  if (event.key === 'Enter') {
    const index = props.model.focusIndex.value
    if (index === null) return
    const item = props.model.rowAt(index)
    if (!item) return
    event.preventDefault()
    emit('activate', item, index)
    return
  }

  if (event.key === ' ') {
    if (props.model.focusIndex.value === null) return
    event.preventDefault()
    props.model.commitFocus(event)
    return
  }

  const next = props.model.moveFocus(event.key, rowsPerPage.value, event)
  if (next === null) return
  event.preventDefault()
  scrollIndexIntoView(next)
}
</script>

<template>
  <div
    ref="viewport"
    role="listbox"
    aria-multiselectable="true"
    :aria-label="label"
    tabindex="0"
    class="min-h-0 flex-1 select-none overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    @scroll.passive="measure"
    @keydown="onKeydown"
  >
    <!-- The spacer carries the full height so the scrollbar describes the whole
         facet, not the handful of rows currently mounted. -->
    <div class="relative w-full" :style="{ height: `${model.total.value * rowHeight}px` }">
      <div
        v-for="row in rows"
        :key="row.item ? `facet:${row.item.id}` : `index:${row.index}`"
        role="option"
        :aria-selected="model.isSelectedAt(row.index)"
        class="absolute inset-x-0 flex items-center gap-2 px-2 text-sm"
        :class="{
          'bg-primary/15': model.isSelectedAt(row.index),
          'ring-1 ring-inset ring-primary/70': model.focusIndex.value === row.index,
          'hover:bg-elevated/70': !model.isSelectedAt(row.index),
          'text-dimmed': !row.item
        }"
        :style="{ top: `${row.index * rowHeight}px`, height: `${rowHeight}px` }"
        @mousedown="onRowPointerDown(row.index, $event)"
        @dblclick="onRowDoubleClick(row.index, $event)"
      >
        <slot name="row" :item="row.item" :index="row.index">
          <span class="truncate">{{ row.item ? '' : 'Loading…' }}</span>
        </slot>
      </div>
    </div>
  </div>
</template>
