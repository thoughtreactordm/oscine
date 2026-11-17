<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { formatTime, pointerFraction } from './seekTime'

/**
 * The seek slider — the transport's one full-width control, lifted out of
 * `NowPlaying` so the bar and the Zen stage scrub the same track through the
 * same store rather than two copies of the same slider.
 *
 * Knows only the playback store, like every piece of the transport. A drag
 * announces itself with `pointerdown` and holds position until release; a
 * keyboard seek produces no pointer events and commits immediately — otherwise
 * an arrow key would move the handle and never reach the audio.
 *
 * Geometry: the strip is exactly the line — no taller, so it shows no band of
 * its own background above or below — and never reaches above its top edge, so
 * whatever sits above it (a list's horizontal scrollbar, most of all) stays fully
 * visible and clickable. The pointer target is taller than the line, but it
 * grows downward, over the transport's own padding, not up. Two things do draw
 * above it, both only while the pointer is on the bar: the thumb, a dot centred
 * on the line that overhangs it by a couple of pixels, and the hover readout,
 * which is `pointer-events-none` so it can never take a click from the content.
 */
const playback = usePlaybackStore()

function onSeekInput(value: number | undefined): void {
  if (value === undefined) return
  if (playback.scrubbing) playback.scrubTo(value)
  else playback.seek(value)
}

/** Pointer position along the bar while it is over it (or dragging), else null. */
const hoverFraction = ref<number | null>(null)
const barWidth = ref(0)

function onPointerMove(event: PointerEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  barWidth.value = rect.width
  hoverFraction.value = pointerFraction(event.clientX, rect.left, rect.width)
}

function onPointerLeave(): void {
  // A drag that leaves the bar keeps its readout until release.
  if (!playback.scrubbing) hoverFraction.value = null
}

function onPointerUp(): void {
  playback.endScrub()
}

const showPreview = computed(
  () => hoverFraction.value !== null && playback.canSeek && playback.duration > 0
)

const previewLabel = computed(() => formatTime((hoverFraction.value ?? 0) * playback.duration))

/**
 * The label is centred on the pointer but held inside the bar's ends, so it is
 * never clipped by the window edge at 0:00 or the last second.
 */
const LABEL_HALF_PX = 28
const previewLeft = computed(() => {
  const x = (hoverFraction.value ?? 0) * barWidth.value
  if (barWidth.value <= LABEL_HALF_PX * 2) return `${x}px`
  return `${Math.min(barWidth.value - LABEL_HALF_PX, Math.max(LABEL_HALF_PX, x))}px`
})
const markerLeft = computed(() => `${(hoverFraction.value ?? 0) * 100}%`)
</script>

<template>
  <div class="relative h-1 shrink-0">
    <USlider
      :model-value="playback.currentTime"
      aria-label="Seek"
      size="xs"
      :min="0"
      :max="playback.duration || 1"
      :step="0.01"
      :disabled="!playback.canSeek"
      :ui="{
        root: 'group absolute inset-x-0 top-0 z-20 h-3 cursor-pointer items-start data-disabled:cursor-default',
        track: 'rounded-none h-1',
        range: 'rounded-none h-1',
        thumb:
          'opacity-0 cursor-pointer group-hover:opacity-100 focus-visible:opacity-100 -top-0.5 w-2 h-2 z-20 transition-transform'
      }"
      @pointerdown="playback.beginScrub()"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @update:model-value="onSeekInput"
      @change="playback.endScrub()"
      @pointerup="onPointerUp"
    />

    <template v-if="showPreview">
      <!-- Where a click would land, marked on the line itself. -->
      <div
        class="pointer-events-none absolute top-0 z-20 h-1 w-px -translate-x-1/2 bg-inverted/70"
        :style="{ left: markerLeft }"
        aria-hidden="true"
      />
      <!-- The time a click would seek to. -->
      <div
        class="pointer-events-none absolute bottom-full z-30 mb-1 -translate-x-1/2 rounded-sm bg-inverted px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-inverted tabular-nums shadow-sm"
        :style="{ left: previewLeft }"
        aria-hidden="true"
      >
        {{ previewLabel }}
      </div>
    </template>
  </div>
</template>
