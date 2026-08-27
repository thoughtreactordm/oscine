<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TagFacetWindow } from '@renderer/panels/tagFacetWindow'

/**
 * The genre/tag browse pane — **W15-5**.
 *
 * A windowed-slice virtualized listbox, the same technique `FacetList` uses and
 * for the same reason: every row is exactly `rowHeight` tall, so the spacer is
 * `total * rowHeight` and the first visible row is `scrollTop / rowHeight` with
 * nothing to measure. Virtualized from the first commit because the invariant
 * asks for it, even though the genre/tag vocabulary is far smaller than the
 * artist or album ones.
 *
 * Simpler than `FacetList`: selection here is a `Set<string>` of keys toggled one
 * at a time, not an anchored range over numeric ids, so there is no shared
 * `indexedSelection` and no context-menu verbs — a click toggles a key, and the
 * pane narrows the library to whatever is ticked.
 */
const props = defineProps<{
  model: TagFacetWindow
  rowHeight: number
  label: string
  overscan?: number
}>()

const OVERSCAN_DEFAULT = 8

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
const focusIndex = ref<number | null>(null)

const overscan = computed(() => props.overscan ?? OVERSCAN_DEFAULT)
const rowsPerPage = computed(() =>
  Math.max(1, Math.floor(viewportHeight.value / props.rowHeight) || 1)
)

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
  const out: Array<{ index: number; item: ReturnType<typeof props.model.rowAt> }> = []
  for (let index = first; index <= last; index++)
    out.push({ index, item: props.model.rowAt(index) })
  return out
})

function measure(): void {
  const element = viewport.value
  if (!element) return
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight
}

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

function toggleAt(index: number): void {
  const item = props.model.rowAt(index)
  if (!item) return
  focusIndex.value = index
  props.model.toggle(item.key)
}

// Keep a keyboard-moved focus on a row that still exists after the list changes.
watch(
  () => props.model.total.value,
  (total) => {
    if (focusIndex.value !== null && focusIndex.value >= total) {
      focusIndex.value = total > 0 ? total - 1 : null
    }
  }
)

function onKeydown(event: KeyboardEvent): void {
  const total = props.model.total.value
  if (event.key === 'Escape') {
    if (props.model.selectionCount.value === 0) return
    event.preventDefault()
    props.model.clearSelection()
    return
  }

  if (event.key === 'Enter' || event.key === ' ') {
    if (focusIndex.value === null) return
    event.preventDefault()
    toggleAt(focusIndex.value)
    return
  }

  let next: number | null = null
  if (event.key === 'ArrowDown') next = Math.min(total - 1, (focusIndex.value ?? -1) + 1)
  else if (event.key === 'ArrowUp') next = Math.max(0, (focusIndex.value ?? total) - 1)
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = total - 1
  if (next === null || total === 0) return

  event.preventDefault()
  focusIndex.value = next
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
    <div class="relative w-full" :style="{ height: `${model.total.value * rowHeight}px` }">
      <div
        v-for="row in rows"
        :key="row.item ? `tag:${row.item.key}` : `index:${row.index}`"
        role="option"
        :aria-selected="model.isSelectedAt(row.index)"
        class="absolute inset-x-0 flex items-center gap-2 px-2 text-sm"
        :class="{
          'bg-primary/15': model.isSelectedAt(row.index),
          'ring-1 ring-inset ring-primary/70': focusIndex === row.index,
          'hover:bg-elevated/70': !model.isSelectedAt(row.index),
          'text-dimmed': !row.item
        }"
        :style="{ top: `${row.index * rowHeight}px`, height: `${rowHeight}px` }"
        @mousedown.left="toggleAt(row.index)"
      >
        <template v-if="row.item">
          <!--
            The origin marker: a file glyph when the key comes from a file's
            genre tag, the app's tag glyph when it is the operator's own. A key
            that is both prefers the file glyph — it is the more surprising of the
            two to be able to browse. Names the concept the way the deck Tags pane
            does, so "From the file" and this column read as one idea.
          -->
          <UIcon
            :name="row.item.hasFile ? 'i-tabler-file-music' : 'i-tabler-tag'"
            class="size-3.5 shrink-0 text-dimmed"
            aria-hidden="true"
          />
          <span class="truncate">{{ row.item.label }}</span>
          <span class="ml-auto shrink-0 text-xs tabular-nums text-dimmed">
            {{ row.item.trackCount }}
          </span>
        </template>
        <span v-else class="truncate">Loading…</span>
      </div>
    </div>
  </div>
</template>
