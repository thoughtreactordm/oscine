<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { EqualizerBand } from '@shared/audio/equalizer'
import { EQUALIZER_BAND_TYPES } from '@shared/audio/equalizer'
import { FALLBACK_SAMPLE_RATE_HZ } from '@renderer/audio/eqResponse'
import { WAVEFORM_SAMPLE_COUNT } from '@renderer/audio'
import { useEqualizerStore } from '@renderer/stores/equalizer'
import { usePlaybackStore } from '@renderer/stores/playback'
import {
  CURVE_POINTS,
  DEFAULT_BAND_Q,
  EQ_PALETTE,
  FILTER_TYPE_LABELS,
  adjustQ,
  addBandAtPoint,
  bandAriaValueText,
  bandCurve,
  compositeCurve,
  createRafBatch,
  curveAreaPath,
  curvePath,
  frequencyGridLines,
  gainGridLines,
  isArrowKey,
  nudgeBandParams,
  pointerToParams,
  qFromDrag,
  removeBand,
  spectrumAreaPath,
  toggleBand,
  typeUsesGain,
  updateBand,
  xForFrequency,
  yForGain,
  type BandPatch,
  type PlotGeometry
} from '@renderer/panels/tools/equalizerModel'
import {
  SPECTRUM_CEIL_DB,
  SPECTRUM_FLOOR_DB,
  createSpectrumSmoother,
  spectrumFrameDb
} from '@renderer/panels/tools/spectrumModel'

/**
 * The draggable SVG curve — **W19-4**.
 *
 * SVG rather than canvas so the theming invariant holds without plumbing: every
 * stroke and fill is a `var(--ui-*)` token (see {@link EQ_PALETTE}), so a theme
 * swap needs no component change — the M5 exit criterion. All the geometry lives
 * in `equalizerModel`, which shares `logFrequencyAt`/`responseCurveDb` with the
 * router, so the picture the operator drags cannot drift from the sound.
 *
 * The curve is recomputed on a rAF batch, not per pointer move: a drag fires far
 * faster than the display refreshes and the curve is ~256 points. The batch
 * governs the single write to `audio.eq.active`, and every downstream `computed`
 * recomputes once off that — so twenty pointer moves in a frame are one recompute.
 *
 * The optional spectrum backdrop runs its own animation loop while the toggle is
 * on and a track is sounding: it FFTs the pre-EQ waveform each frame (see
 * `spectrumModel`), draws the raw distribution, and — because the tap is pre-EQ —
 * draws a second area with the response added, so the operator sees the curve's
 * influence directly rather than inferring it.
 */

const props = defineProps<{
  /** The dB half-range the plot shows; the ±12 / ±24 toggle lives in the parent. */
  maxGainDb: number
  /** Whether to draw the live spectrum behind the curve. */
  showSpectrum: boolean
}>()

const eq = useEqualizerStore()
const playback = usePlaybackStore()
const toast = useToast()

/**
 * No live sample rate is plumbed to the renderer's UI — it lives on the decoded
 * context and never crosses the `AudioEngine` interface — so the curve is drawn
 * at the fallback rate. The only visible consequence is the top octave, where
 * the bilinear transform's warp is rate-dependent; everything below ~10 kHz is
 * identical at any rate. Wiring the live rate through is its own change.
 */
const sampleRateHz = FALLBACK_SAMPLE_RATE_HZ

// ── Layout: measure the container, keep handles circular at 1:1 ─────────────
const MARGIN_LEFT = 46
const MARGIN_RIGHT = 14
const MARGIN_TOP = 16
const MARGIN_BOTTOM = 26
// Large enough to sit a band numeral inside and to be a real pointer target.
const HANDLE_RADIUS = 11

const container = ref<HTMLElement | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const width = ref(0)
const height = ref(0)
let resize: ResizeObserver | null = null

const plotWidth = computed(() => Math.max(0, width.value - MARGIN_LEFT - MARGIN_RIGHT))
const plotHeight = computed(() => Math.max(0, height.value - MARGIN_TOP - MARGIN_BOTTOM))

const geometry = computed<PlotGeometry>(() => ({
  width: plotWidth.value,
  height: plotHeight.value,
  maxGainDb: props.maxGainDb
}))

const bands = computed(() => eq.active.bands)
const bypassed = computed(() => !eq.enabled)

// ── The drawn geometry, all derived from the single `active` source ──────────
const freqLines = computed(() => frequencyGridLines(geometry.value))
const dbLines = computed(() => gainGridLines(geometry.value))

// The composite response as numbers, shared by the drawn curve and the shaped
// spectrum so the two agree on the exact same grid.
const compositeDbCurve = computed(() => compositeCurve(eq.active, sampleRateHz, CURVE_POINTS))
const compositeD = computed(() => curvePath(compositeDbCurve.value, geometry.value))

const bandShapes = computed(() =>
  bands.value.map((band) => ({
    id: band.id,
    enabled: band.enabled,
    area: curveAreaPath(bandCurve(band, sampleRateHz), geometry.value)
  }))
)

interface HandleView {
  readonly band: EqualizerBand
  readonly index: number
  readonly cx: number
  readonly cy: number
}

const handles = computed<HandleView[]>(() =>
  bands.value.map((band, index) => ({
    band,
    index,
    cx: xForFrequency(band.frequencyHz, geometry.value),
    cy: yForGain(typeUsesGain(band.type) ? band.gainDb : 0, geometry.value)
  }))
)

// ── Interaction state ────────────────────────────────────────────────────────
type DragMode = 'move' | 'q'
const dragging = ref<{ id: string; mode: DragMode; startQ: number; startY: number } | null>(null)
const focusedId = ref<string | null>(null)
const hoverId = ref<string | null>(null)
/** The handle whose value label is shown: dragged, else focused, else hovered. */
const activeId = computed(() => dragging.value?.id ?? focusedId.value ?? hoverId.value)
const activeHandle = computed(() => handles.value.find((h) => h.band.id === activeId.value) ?? null)

// Latest pointer position in plot-local pixels — plain, not reactive: it changes
// at pointer-move rate and only the rAF commit reads it.
const pointer = { x: 0, y: 0 }
const batch = createRafBatch(
  commitDrag,
  (cb) => requestAnimationFrame(cb),
  (handle) => cancelAnimationFrame(handle)
)

function toLocal(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = svgEl.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: event.clientX - rect.left - MARGIN_LEFT, y: event.clientY - rect.top - MARGIN_TOP }
}

function writeBand(id: string, params: BandPatch): void {
  eq.active = updateBand(eq.active, id, params)
}

function commitDrag(): void {
  const drag = dragging.value
  if (!drag) return
  const band = eq.active.bands.find((entry) => entry.id === drag.id)
  if (!band) return
  if (drag.mode === 'q') {
    writeBand(drag.id, { q: qFromDrag(drag.startQ, pointer.y - drag.startY) })
    return
  }
  const params = pointerToParams(pointer.x, pointer.y, geometry.value)
  writeBand(drag.id, {
    frequencyHz: params.frequencyHz,
    ...(typeUsesGain(band.type) ? { gainDb: params.gainDb } : {})
  })
}

function onHandleDown(event: PointerEvent, band: EqualizerBand): void {
  if (event.button !== 0) return
  event.preventDefault()
  // Alt-click is per-band bypass, not a drag — the operator finding which band
  // does the damage by muting each in turn.
  if (event.altKey) {
    eq.active = toggleBand(eq.active, band.id)
    return
  }
  const local = toLocal(event)
  pointer.x = local.x
  pointer.y = local.y
  ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
  // Bracket the gesture so its per-frame writes are not each an undo step — the
  // whole drag is one entry, recorded on pointer-up (W19-10).
  eq.beginInteractive()
  dragging.value = {
    id: band.id,
    mode: event.shiftKey ? 'q' : 'move',
    startQ: band.q,
    startY: local.y
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  const local = toLocal(event)
  pointer.x = local.x
  pointer.y = local.y
  batch.request()
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging.value) return
  const local = toLocal(event)
  pointer.x = local.x
  pointer.y = local.y
  batch.flush()
  dragging.value = null
  // Close the gesture: records the landed curve as a single undo step (W19-10).
  eq.endInteractive()
}

function onHandleWheel(event: WheelEvent, band: EqualizerBand): void {
  event.preventDefault()
  writeBand(band.id, { q: adjustQ(band.q, event.deltaY < 0 ? 1 : -1) })
  hoverId.value = band.id
}

function onHandleKey(event: KeyboardEvent, band: EqualizerBand): void {
  if (!isArrowKey(event.key)) return
  event.preventDefault()
  const params = nudgeBandParams(band, event.key, event.shiftKey, geometry.value)
  writeBand(band.id, {
    frequencyHz: params.frequencyHz,
    ...(typeUsesGain(band.type) ? { gainDb: params.gainDb } : {})
  })
}

function onBackgroundDblClick(event: MouseEvent): void {
  const local = toLocal(event)
  const outcome = addBandAtPoint(eq.active, local.x, local.y, geometry.value, () =>
    crypto.randomUUID()
  )
  if (outcome.ok) {
    eq.active = outcome.spec
    focusedId.value = outcome.bandId
  } else {
    toast.add({ title: outcome.reason, icon: 'i-tabler-alert-triangle', color: 'warning' })
  }
}

// ── The handle context menu — filter type, reset, remove ─────────────────────
const menu = ref<{ id: string; x: number; y: number } | null>(null)
const bandTypes = EQUALIZER_BAND_TYPES

function openMenu(event: MouseEvent, band: EqualizerBand): void {
  const rect = container.value?.getBoundingClientRect()
  menu.value = {
    id: band.id,
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0)
  }
}

function closeMenu(): void {
  menu.value = null
}

function setType(id: string, type: EqualizerBand['type']): void {
  writeBand(id, { type })
  closeMenu()
}

function resetBand(id: string): void {
  writeBand(id, { gainDb: 0, q: DEFAULT_BAND_Q })
  closeMenu()
}

function deleteBand(id: string): void {
  eq.active = removeBand(eq.active, id)
  if (focusedId.value === id) focusedId.value = null
  closeMenu()
}

const menuBandType = computed(
  () => bands.value.find((band) => band.id === menu.value?.id)?.type ?? null
)

// ── Value label for the active handle ────────────────────────────────────────
function labelLines(band: EqualizerBand): string[] {
  return bandAriaValueText(band).split(', ')
}

// ── The spectrum backdrop ────────────────────────────────────────────────────
const rawSpectrumD = ref('')
const shapedSpectrumD = ref('')
const spectrumSamples = new Float32Array(WAVEFORM_SAMPLE_COUNT)
const spectrumSmoother = createSpectrumSmoother(CURVE_POINTS)
let spectrumFrame: number | null = null

function drawSpectrum(): void {
  const geo = geometry.value
  const raw = spectrumSmoother.values
  rawSpectrumD.value = spectrumAreaPath(raw, SPECTRUM_FLOOR_DB, SPECTRUM_CEIL_DB, geo)
  // Pre-EQ tap, so the curve's effect is the response added on top — but only
  // when it is actually in circuit, which is what the master toggle decides.
  if (bypassed.value) {
    shapedSpectrumD.value = ''
    return
  }
  const composite = compositeDbCurve.value
  const shaped = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) shaped[i] = raw[i] + (composite[i] ?? 0)
  shapedSpectrumD.value = spectrumAreaPath(shaped, SPECTRUM_FLOOR_DB, SPECTRUM_CEIL_DB, geo)
}

function spectrumTick(): void {
  if (playback.readWaveform(spectrumSamples)) {
    spectrumSmoother.push(spectrumFrameDb(spectrumSamples, sampleRateHz, CURVE_POINTS))
  } else {
    spectrumSmoother.decay()
  }
  drawSpectrum()
  // Keep running while it can change: a sounding track, or a tail still decaying.
  if (props.showSpectrum && (playback.isPlaying || spectrumSmoother.active())) {
    spectrumFrame = requestAnimationFrame(spectrumTick)
  } else {
    spectrumFrame = null
  }
}

function startSpectrum(): void {
  if (spectrumFrame !== null || !props.showSpectrum) return
  spectrumFrame = requestAnimationFrame(spectrumTick)
}

function stopSpectrum(): void {
  if (spectrumFrame !== null) {
    cancelAnimationFrame(spectrumFrame)
    spectrumFrame = null
  }
  spectrumSmoother.reset()
  rawSpectrumD.value = ''
  shapedSpectrumD.value = ''
}

watch(
  () => props.showSpectrum,
  (on) => (on ? startSpectrum() : stopSpectrum())
)
watch(
  () => playback.isPlaying,
  (playing) => {
    if (playing) startSpectrum()
  }
)

onMounted(() => {
  const el = container.value
  if (!el) return
  const measure = (): void => {
    width.value = el.clientWidth
    height.value = el.clientHeight
  }
  measure()
  resize = new ResizeObserver(measure)
  resize.observe(el)
  if (props.showSpectrum && playback.isPlaying) startSpectrum()
})

onUnmounted(() => {
  resize?.disconnect()
  resize = null
  batch.cancel()
  stopSpectrum()
})
</script>

<template>
  <div ref="container" class="relative min-h-0 flex-1 select-none overflow-hidden">
    <svg
      ref="svgEl"
      class="block size-full touch-none"
      :width="width"
      :height="height"
      role="group"
      aria-label="Equalizer response curve"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <g :transform="`translate(${MARGIN_LEFT}, ${MARGIN_TOP})`" :opacity="bypassed ? 0.45 : 1">
        <!-- Background hit target: double-click adds a band. -->
        <rect
          x="0"
          y="0"
          :width="plotWidth"
          :height="plotHeight"
          fill="transparent"
          @dblclick="onBackgroundDblClick"
        />

        <!-- The spectrum backdrop: raw distribution, plus the curve-shaped area on
             top when the EQ is in circuit, so the influence reads at a glance. -->
        <g v-if="showSpectrum" pointer-events="none">
          <path
            :d="rawSpectrumD"
            :fill="EQ_PALETTE.spectrumRaw"
            fill-opacity="0.22"
            stroke="none"
          />
          <path
            v-if="shapedSpectrumD"
            :d="shapedSpectrumD"
            :fill="EQ_PALETTE.spectrumShaped"
            fill-opacity="0.16"
            stroke="none"
          />
        </g>

        <!-- Frequency gridlines + labels. Decoration: never intercept the pointer,
             so a double-click over one still reaches the background to add a band. -->
        <g pointer-events="none">
          <line
            v-for="line in freqLines"
            :key="`f${line.frequencyHz}`"
            :x1="line.x"
            :x2="line.x"
            y1="0"
            :y2="plotHeight"
            :stroke="line.label ? EQ_PALETTE.gridLineStrong : EQ_PALETTE.gridLine"
            stroke-width="1"
            :stroke-opacity="line.label ? 0.5 : 0.25"
          />
          <text
            v-for="line in freqLines.filter((l) => l.label)"
            :key="`fl${line.frequencyHz}`"
            :x="line.x"
            :y="plotHeight + 16"
            text-anchor="middle"
            class="text-[10px]"
            :fill="EQ_PALETTE.axisLabel"
          >
            {{ line.label }}
          </text>
        </g>

        <!-- dB gridlines + labels. The 0 dB line reads stronger. -->
        <g pointer-events="none">
          <line
            v-for="line in dbLines"
            :key="`d${line.gainDb}`"
            x1="0"
            :x2="plotWidth"
            :y1="line.y"
            :y2="line.y"
            :stroke="line.gainDb === 0 ? EQ_PALETTE.gridLineStrong : EQ_PALETTE.gridLine"
            stroke-width="1"
            :stroke-opacity="line.gainDb === 0 ? 0.6 : 0.25"
          />
          <text
            v-for="line in dbLines"
            :key="`dl${line.gainDb}`"
            x="-8"
            :y="line.y + 3"
            text-anchor="end"
            class="text-[10px]"
            :fill="EQ_PALETTE.axisLabel"
          >
            {{ line.label }}
          </text>
        </g>

        <!-- One translucent fill per band; a bypassed band is dimmed. Yielded to the
             spectrum when it is on, which would otherwise be two primary washes. -->
        <template v-if="!showSpectrum">
          <path
            v-for="shape in bandShapes"
            :key="`b${shape.id}`"
            :d="shape.area"
            :fill="shape.enabled ? EQ_PALETTE.bandFill : EQ_PALETTE.disabled"
            :fill-opacity="shape.enabled ? 0.12 : 0.06"
            stroke="none"
            pointer-events="none"
          />
        </template>

        <!-- The composite response. -->
        <path
          :d="compositeD"
          fill="none"
          :stroke="EQ_PALETTE.curveStroke"
          stroke-width="2"
          stroke-linejoin="round"
          pointer-events="none"
        />

        <!-- Draggable handles. -->
        <g
          v-for="handle in handles"
          :key="`h${handle.band.id}`"
          role="slider"
          tabindex="0"
          :aria-label="`Band ${FILTER_TYPE_LABELS[handle.band.type]}`"
          :aria-valuetext="bandAriaValueText(handle.band)"
          class="cursor-grab focus:outline-none"
          @pointerdown="onHandleDown($event, handle.band)"
          @wheel="onHandleWheel($event, handle.band)"
          @keydown="onHandleKey($event, handle.band)"
          @focus="focusedId = handle.band.id"
          @blur="focusedId === handle.band.id && (focusedId = null)"
          @pointerenter="hoverId = handle.band.id"
          @pointerleave="hoverId === handle.band.id && (hoverId = null)"
          @contextmenu.prevent="openMenu($event, handle.band)"
        >
          <!-- A wide invisible target so a real pointer, not the screenshot, can grab it. -->
          <circle :cx="handle.cx" :cy="handle.cy" r="18" fill="transparent" />
          <circle
            v-if="activeId === handle.band.id"
            :cx="handle.cx"
            :cy="handle.cy"
            :r="HANDLE_RADIUS + 4"
            fill="none"
            :stroke="EQ_PALETTE.handle"
            stroke-width="1.5"
            stroke-opacity="0.5"
          />
          <circle
            :cx="handle.cx"
            :cy="handle.cy"
            :r="HANDLE_RADIUS"
            :fill="handle.band.enabled ? EQ_PALETTE.handle : EQ_PALETTE.disabled"
            :stroke="EQ_PALETTE.handleRing"
            stroke-width="2"
            :fill-opacity="handle.band.enabled ? 1 : 0.6"
          />
          <!-- The band's number, so plot and table name the same band. -->
          <text
            :x="handle.cx"
            :y="handle.cy"
            text-anchor="middle"
            dominant-baseline="central"
            :fill="EQ_PALETTE.handleLabel"
            class="text-[10px] font-semibold"
            pointer-events="none"
          >
            {{ handle.index + 1 }}
          </text>
        </g>

        <!-- The active handle's value, shown because Q especially must not change unseen. -->
        <g
          v-if="activeHandle"
          :transform="`translate(${activeHandle.cx}, ${Math.max(activeHandle.cy - 14, 10)})`"
          pointer-events="none"
        >
          <text
            text-anchor="middle"
            :y="-labelLines(activeHandle.band).length * 12"
            :fill="EQ_PALETTE.axisLabel"
            class="text-[10px]"
          >
            <tspan
              v-for="(line, i) in labelLines(activeHandle.band)"
              :key="i"
              :x="0"
              :dy="i === 0 ? 0 : 12"
            >
              {{ line }}
            </tspan>
          </text>
        </g>
      </g>
    </svg>

    <!-- Empty state and bypass badge, over the plot. -->
    <p
      v-if="bands.length === 0"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-dimmed"
    >
      Double-click to add a band.
    </p>
    <span
      v-if="bypassed && bands.length > 0"
      class="pointer-events-none absolute right-3 top-2 rounded bg-elevated px-2 py-0.5 text-[10px] font-medium text-dimmed"
    >
      Bypassed
    </span>

    <!-- Handle context menu. A backdrop closes it. -->
    <template v-if="menu">
      <div class="fixed inset-0 z-10" @pointerdown="closeMenu" @contextmenu.prevent="closeMenu" />
      <div
        class="absolute z-20 min-w-40 rounded-md border border-default bg-elevated py-1 text-xs shadow-lg"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        role="menu"
      >
        <p class="px-3 py-1 text-[10px] uppercase tracking-wide text-dimmed">Filter type</p>
        <button
          v-for="type in bandTypes"
          :key="type"
          type="button"
          role="menuitemradio"
          :aria-checked="menuBandType === type"
          class="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-primary/10"
          @click="setType(menu.id, type)"
        >
          <span>{{ FILTER_TYPE_LABELS[type] }}</span>
          <UIcon v-if="menuBandType === type" name="i-tabler-check" class="size-3.5 text-primary" />
        </button>
        <div class="my-1 border-t border-default/60" />
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-primary/10"
          @click="resetBand(menu.id)"
        >
          <UIcon name="i-tabler-arrow-back-up" class="size-3.5 text-dimmed" />
          Reset band
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1 text-left text-error hover:bg-error/10"
          @click="deleteBand(menu.id)"
        >
          <UIcon name="i-tabler-trash" class="size-3.5" />
          Remove band
        </button>
      </div>
    </template>
  </div>
</template>
