<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import TriCheck from '@renderer/panels/tools/TriCheck.vue'
import type { CheckState } from '@renderer/panels/tools/tagWritebackModel'
import type { RipDraftTrack } from '@renderer/panels/tools/cdRipModel'
import type { RipOutcome } from '@shared/cdrip'
import { outcomeMeta } from '@renderer/panels/tools/cdRipModel'
import { formatDuration } from '@renderer/panels/displayFormat'

/**
 * The rip track table — **W18-7**. Virtualized from the first commit: Red Book
 * caps a disc at 99 tracks, and the invariant has no exception clause.
 */
const props = defineProps<{
  tracks: readonly RipDraftTrack[]
  headerState: CheckState
  durationOf: (number: number) => number
  outcomes?: ReadonlyMap<number, RipOutcome>
  disabled?: boolean
}>()

const emit = defineEmits<{
  toggleAll: []
  toggle: [number: number]
  'update:title': [number: number, title: string]
  'update:artist': [number: number, artist: string]
}>()

const ROW_PX = 40
const OVERSCAN = 6
const gridColumns = '44px 48px minmax(12rem, 1fr) minmax(10rem, 1fr) 64px 108px'

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportPx = ref(0)

const visible = computed(() =>
  visibleRange({
    total: props.tracks.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value,
    overscan: OVERSCAN
  })
)
const drawn = computed(() => props.tracks.slice(visible.value.first, visible.value.last + 1))

function onScroll(): void {
  const element = viewport.value
  if (element === null) return
  scrollTop.value = element.scrollTop
  viewportPx.value = element.clientHeight
}

function measure(): void {
  viewportPx.value = viewport.value?.clientHeight ?? 0
}

let observer: ResizeObserver | null = null
function attach(): void {
  if (observer !== null || viewport.value === null) return
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(viewport.value)
}
function detach(): void {
  observer?.disconnect()
  observer = null
}

watch(
  () => props.tracks.length,
  async () => {
    await nextTick()
    attach()
  },
  { immediate: true }
)
onBeforeUnmount(detach)

function duration(number: number): string {
  return formatDuration(props.durationOf(number), 'auto')
}
</script>

<template>
  <div ref="viewport" class="min-h-0 flex-1 overflow-auto" @scroll.passive="onScroll">
    <div class="min-w-max">
      <div
        class="sticky top-0 z-10 grid items-center border-b border-default bg-default text-xs font-medium text-dimmed"
        :style="{ gridTemplateColumns: gridColumns }"
      >
        <div class="grid place-items-center py-2">
          <TriCheck
            :state="headerState"
            aria-label="Include every track"
            :disabled="disabled"
            @toggle="emit('toggleAll')"
          />
        </div>
        <div class="px-2 py-2">#</div>
        <div class="px-2 py-2">Title</div>
        <div class="px-2 py-2">Artist</div>
        <div class="px-2 py-2">Time</div>
        <div class="px-2 py-2">{{ outcomes && outcomes.size > 0 ? 'Result' : '' }}</div>
      </div>

      <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />

      <div
        v-for="track in drawn"
        :key="track.number"
        class="grid items-center border-b border-default/60"
        :style="{ gridTemplateColumns: gridColumns, height: `${ROW_PX}px` }"
      >
        <div class="grid place-items-center">
          <TriCheck
            :state="track.included ? 'all' : 'none'"
            :aria-label="`Include track ${track.number}`"
            :disabled="disabled"
            @toggle="emit('toggle', track.number)"
          />
        </div>
        <div class="px-2 text-xs tabular-nums text-muted">{{ track.number }}</div>
        <div class="min-w-0 px-1">
          <UInput
            :model-value="track.title"
            size="xs"
            variant="none"
            class="w-full"
            placeholder="Unknown Title"
            :disabled="disabled"
            :aria-label="`Title for track ${track.number}`"
            @update:model-value="emit('update:title', track.number, String($event ?? ''))"
          />
        </div>
        <div class="min-w-0 px-1">
          <UInput
            :model-value="track.artist"
            size="xs"
            variant="none"
            class="w-full"
            placeholder="Unknown Artist"
            :disabled="disabled"
            :aria-label="`Artist for track ${track.number}`"
            @update:model-value="emit('update:artist', track.number, String($event ?? ''))"
          />
        </div>
        <div class="px-2 text-xs tabular-nums text-dimmed">{{ duration(track.number) }}</div>
        <div class="min-w-0 px-2">
          <span
            v-if="outcomes?.get(track.number)"
            class="inline-flex items-center gap-1 text-[11px]"
            :class="outcomeMeta(outcomes.get(track.number)!.status).cls"
          >
            <UIcon :name="outcomeMeta(outcomes.get(track.number)!.status).icon" class="size-3.5" />
            {{ outcomeMeta(outcomes.get(track.number)!.status).text }}
          </span>
        </div>
      </div>

      <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
    </div>
  </div>
</template>
