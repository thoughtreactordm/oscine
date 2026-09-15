<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEVICE_EQ_LIBRARY, DEVICE_EQ_SOURCE } from '@shared/audio/deviceEqLibrary'
import type { DeviceEqProfile } from '@shared/audio/deviceEqLibrary'
import { filterDeviceProfiles } from '@renderer/panels/tools/deviceEqPickerModel'
import { visibleRange } from '@renderer/panels/listViewport'

/**
 * The bundled-device picker (W19-9): a searchable, virtualized list of oratory1990
 * profiles, reached from the EQ preset menu's "Load device…".
 *
 * Its own component and lazy-loaded by the tool, because the corpus asset it pulls
 * in (`deviceEqLibrary.generated`) is ~1.3 MB of source — deferring the import until
 * the picker first opens keeps it out of the pane's initial chunk. The list is
 * virtualized from the first commit like every other: 736 rows go through the shared
 * `visibleRange` windowing, not a v-for over the lot.
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [profile: DeviceEqProfile]
}>()

const ROW_PX = 40

const query = ref('')
const matches = computed(() => filterDeviceProfiles(DEVICE_EQ_LIBRARY, query.value))

// ── Virtualization (in-memory: the list is already loaded, so just arithmetic) ──
const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportPx = ref(0)

const range = computed(() =>
  visibleRange({
    total: matches.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const rows = computed(() => {
  const { first, last } = range.value
  const out: { index: number; profile: DeviceEqProfile }[] = []
  for (let index = first; index <= last; index++) out.push({ index, profile: matches.value[index] })
  return out
})

function measure(): void {
  const element = viewport.value
  if (!element) return
  scrollTop.value = element.scrollTop
  viewportPx.value = element.clientHeight
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

// ── Keyboard selection, driven from the search field ─────────────────────────
const activeIndex = ref(0)

// A new query re-ranks the list; the highlight goes back to the top match and the
// viewport scrolls home so the best result is what the operator sees.
watch(matches, () => {
  activeIndex.value = 0
  if (viewport.value) viewport.value.scrollTop = 0
  scrollTop.value = 0
})

// Opening the picker is a fresh search: clear the query, reset the highlight, and
// focus the field so typing narrows immediately.
const searchInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    query.value = ''
    activeIndex.value = 0
    await nextTick()
    measure()
    searchInput.value?.inputRef?.focus()
  }
)

function scrollActiveIntoView(): void {
  const element = viewport.value
  if (!element) return
  const top = activeIndex.value * ROW_PX
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + ROW_PX > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + ROW_PX - element.clientHeight
  }
  scrollTop.value = element.scrollTop
}

function moveActive(delta: number): void {
  const count = matches.value.length
  if (count === 0) return
  activeIndex.value = Math.min(count - 1, Math.max(0, activeIndex.value + delta))
  scrollActiveIntoView()
}

function choose(profile: DeviceEqProfile | undefined): void {
  if (profile) emit('select', profile)
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    choose(matches.value[activeIndex.value])
  }
}

const TYPE_LABEL: Record<DeviceEqProfile['type'], string> = {
  'over-ear': 'Over-ear',
  'in-ear': 'In-ear',
  earbud: 'Earbud'
}
</script>

<template>
  <UModal
    :open="open"
    title="Load device EQ"
    :description="DEVICE_EQ_SOURCE.credit"
    :ui="{ body: 'p-0 sm:p-0', footer: 'justify-between' }"
    @update:open="(value: boolean) => emit('update:open', value)"
  >
    <template #body>
      <div class="flex flex-col">
        <div class="border-b border-default p-3">
          <UInput
            ref="searchInput"
            v-model="query"
            icon="i-tabler-search"
            placeholder="Search headphones & IEMs…"
            class="w-full"
            aria-label="Search device EQ profiles"
            @keydown="onSearchKeydown"
          />
        </div>

        <div
          ref="viewport"
          role="listbox"
          aria-label="Device EQ profiles"
          class="h-80 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          @scroll.passive="measure"
        >
          <p v-if="matches.length === 0" class="px-3 py-6 text-center text-sm text-muted">
            No device matches “{{ query }}”.
          </p>
          <template v-else>
            <div :style="{ height: `${range.topPx}px` }" />
            <button
              v-for="row in rows"
              :key="row.profile.id"
              type="button"
              role="option"
              :aria-selected="row.index === activeIndex"
              class="flex w-full items-center gap-2 px-3 text-left text-sm text-default outline-none"
              :class="row.index === activeIndex ? 'bg-primary/15' : 'hover:bg-elevated/70'"
              :style="{ height: `${ROW_PX}px` }"
              @click="choose(row.profile)"
              @mousemove="activeIndex = row.index"
            >
              <span class="min-w-0 flex-1 truncate">{{ row.profile.name }}</span>
              <span class="shrink-0 text-[11px] uppercase text-dimmed">
                {{ TYPE_LABEL[row.profile.type] }}
              </span>
            </button>
            <div :style="{ height: `${range.bottomPx}px` }" />
          </template>
        </div>

        <!-- The caveats W19-8 inherited from Web Audio, where the operator sees them. -->
        <p class="border-t border-default px-3 py-2 text-[11px] text-dimmed">
          Long profiles are truncated to 12 bands; a shelf filter's Q is ignored.
        </p>
      </div>
    </template>

    <template #footer>
      <span class="text-xs text-muted">{{ matches.length.toLocaleString() }} devices</span>
      <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Close</UButton>
    </template>
  </UModal>
</template>
