<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatListeningTime, formatPlays } from '@renderer/panels/displayFormat'
import {
  bucketAtX,
  chartGeometry,
  formatBucketSpan,
  valueOf
} from '@renderer/panels/listening/listeningChart'
import type { StatsBucket, StatsOverTimePoint, StatsSort } from '@shared/stats'

/**
 * Listening over time — one series, one axis, no dependency.
 *
 * Every number on screen comes out of `listeningChart.ts`; this file is the
 * paint. The split is what makes the geometry testable without a DOM, and it is
 * also what keeps the two rules this surface is most likely to break visible:
 *
 * **No colour is written here.** Marks are `currentColor` against the token
 * layer's own text classes — `text-primary` for the series, `text-muted` and
 * `text-dimmed` for the chrome — so a theme swap moves this chart with it and
 * touches no component code, which is M5's exit criterion stated as a chart.
 *
 * **The readout is not a tooltip.** It sits above the plot as ordinary text and
 * is filled in whether or not anything is hovered: with the cursor away it
 * direct-labels the busiest bucket, and under a pointer or an arrow key it
 * follows the cursor. A value that can only be reached by hovering is a value a
 * keyboard cannot read, and there is no table view here to fall back to.
 *
 * The mark changes with the density and that is on purpose. A week is seven
 * discrete buckets and draws as seven columns; four years of weeks is a shape,
 * not two hundred marks, and draws as a line over its own wash. The threshold
 * is arithmetic — whether a column and its two-pixel gap still fit in a band —
 * rather than a bucket count, so it follows the pane being resized.
 */

const props = defineProps<{
  points: readonly StatsOverTimePoint[]
  bucket: StatsBucket
  sort: StatsSort
}>()

const HEIGHT_PX = 176

const frame = ref<HTMLElement | null>(null)
const widthPx = ref(0)
const cursor = ref<number | null>(null)

let observer: ResizeObserver | null = null

function measure(): void {
  widthPx.value = frame.value?.clientWidth ?? 0
}

onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (frame.value) observer.observe(frame.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

const geometry = computed(() =>
  chartGeometry({
    points: props.points,
    bucket: props.bucket,
    sort: props.sort,
    width: widthPx.value,
    height: HEIGHT_PX
  })
)

/**
 * Which bucket the readout is describing: the cursor's, or the peak.
 *
 * The peak rather than the last bucket, because "the busiest week" is the one
 * fact a glance at this chart is trying to establish, and it is the label the
 * marks-and-anatomy rule endorses putting on a chart directly — the extreme,
 * not a number on every point.
 */
const readIndex = computed(() => cursor.value ?? geometry.value.peakIndex)

/** Where the crosshair and the cursor dot go, or `null` when nothing is pointed at. */
const cursorMark = computed(() =>
  cursor.value === null ? null : (geometry.value.marks[cursor.value] ?? null)
)

const readout = computed(() => {
  const index = readIndex.value
  const point = index < 0 ? undefined : props.points[index]
  if (point === undefined) return null

  return {
    when: formatBucketSpan(point.startedAt, props.bucket),
    plays: formatPlays(point.listens),
    time: formatListeningTime(point.msListened),
    /** The caption only claims a peak while the operator is not pointing at something else. */
    isPeak: cursor.value === null
  }
})

/** What a screen reader is told the picture is, since the picture itself says nothing. */
const summaryLabel = computed(() => {
  const total = props.points.reduce((sum, point) => sum + valueOf(point, props.sort), 0)
  const written = props.sort === 'listens' ? formatPlays(total) : formatListeningTime(total)
  return `Listening over time: ${props.points.length} buckets, ${written} in total.`
})

function onPointerMove(event: PointerEvent): void {
  const element = frame.value
  if (element === null) return
  cursor.value = bucketAtX(geometry.value, event.clientX - element.getBoundingClientRect().left)
}

function onKeydown(event: KeyboardEvent): void {
  const last = props.points.length - 1
  if (last < 0) return

  const from = cursor.value ?? geometry.value.peakIndex
  if (event.key === 'ArrowLeft') cursor.value = Math.max(0, (from < 0 ? 0 : from) - 1)
  else if (event.key === 'ArrowRight') cursor.value = Math.min(last, (from < 0 ? -1 : from) + 1)
  else if (event.key === 'Home') cursor.value = 0
  else if (event.key === 'End') cursor.value = last
  else if (event.key === 'Escape') cursor.value = null
  else return

  event.preventDefault()
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <!--
      The readout, above the plot rather than floating over it. Values lead and
      the label follows: the reader already has the chart and wants the number.
    -->
    <p class="flex min-h-5 flex-wrap items-baseline gap-x-2 text-xs" aria-live="polite">
      <template v-if="readout">
        <span class="font-medium text-highlighted">{{ readout.when }}</span>
        <span class="tabular-nums text-default">{{ readout.plays }}</span>
        <span class="text-muted">·</span>
        <span class="tabular-nums text-default">{{ readout.time }}</span>
        <span v-if="readout.isPeak" class="text-dimmed">busiest</span>
      </template>
      <span v-else class="text-dimmed">Nothing played in this window.</span>
    </p>

    <div
      ref="frame"
      class="relative rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
      :style="{ height: `${HEIGHT_PX}px` }"
      tabindex="0"
      role="img"
      :aria-label="summaryLabel"
      @pointermove="onPointerMove"
      @pointerleave="cursor = null"
      @blur="cursor = null"
      @keydown="onKeydown"
    >
      <svg
        v-if="geometry.form !== 'empty'"
        :width="geometry.width"
        :height="geometry.height"
        :viewBox="`0 0 ${geometry.width} ${geometry.height}`"
        aria-hidden="true"
        class="overflow-visible"
      >
        <!--
          Solid hairlines one step off the surface, never dashed: a dashed grid
          reads as a threshold or a projection when it is only a grid.
        -->
        <g class="text-muted">
          <line
            v-for="line in geometry.gridlines"
            :key="`grid-${line.label}`"
            :x1="geometry.plot.x"
            :x2="geometry.plot.x + geometry.plot.w"
            :y1="line.y"
            :y2="line.y"
            stroke="currentColor"
            stroke-width="1"
            stroke-opacity="0.25"
          />
        </g>

        <g class="fill-current text-dimmed" font-size="10">
          <text
            v-for="line in geometry.gridlines"
            :key="`tick-${line.label}`"
            :x="geometry.plot.x - 6"
            :y="line.y"
            text-anchor="end"
            dominant-baseline="middle"
            class="tabular-nums"
          >
            {{ line.label }}
          </text>
          <text
            v-for="tick in geometry.ticks"
            :key="`x-${tick.x}`"
            :x="tick.x"
            :y="geometry.baseline + 12"
            text-anchor="middle"
            dominant-baseline="hanging"
          >
            {{ tick.label }}
          </text>
        </g>

        <!-- The crosshair finds the X, so the reader aims at a date and not at a mark. -->
        <line
          v-if="cursorMark"
          :x1="cursorMark.x"
          :x2="cursorMark.x"
          :y1="geometry.plot.y"
          :y2="geometry.baseline"
          class="text-primary"
          stroke="currentColor"
          stroke-width="1"
          stroke-opacity="0.5"
        />

        <g v-if="geometry.form === 'columns'" class="fill-current text-primary">
          <path
            v-for="column in geometry.columns"
            :key="`bar-${column.index}`"
            :d="column.path"
            :fill-opacity="cursor === null || cursor === column.index ? 1 : 0.55"
          />
        </g>

        <g v-else>
          <!-- A wash, never a saturated block: the line carries the value. -->
          <path :d="geometry.areaPath" class="fill-current text-primary" fill-opacity="0.1" />
          <path
            :d="geometry.linePath"
            class="text-primary"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <!--
            The end-marker carries a 2px ring in the surface colour so it stays
            legible where it sits on its own line.
          -->
          <circle
            v-if="cursorMark"
            :cx="cursorMark.x"
            :cy="cursorMark.y"
            r="4"
            class="fill-current text-primary"
            stroke="var(--ui-bg)"
            stroke-width="2"
          />
        </g>

        <!--
          The hit targets: the whole band, transparent, so the pointer never has
          to land on the painted pixels. Only the column form needs them — the
          area form has nothing to land on, which is what the crosshair and the
          nearest-band test are for.
        -->
        <g v-if="geometry.form === 'columns'">
          <rect
            v-for="column in geometry.columns"
            :key="`hit-${column.index}`"
            :x="column.hitX"
            :y="geometry.plot.y"
            :width="column.hitW"
            :height="geometry.plot.h"
            fill="transparent"
          />
        </g>
      </svg>
    </div>
  </div>
</template>
