<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { WAVEFORM_SAMPLE_COUNT } from '@renderer/audio'
import { useSettings } from '@renderer/settings'
import { onThemeChange } from '@renderer/theme'
import { usePlaybackStore } from '@renderer/stores/playback'
import { NOW_PLAYING_WAVEFORM_KEY } from '@shared/settings'
import { createWaveformShaper, type WaveformShaper } from './waveformRibbon'

/**
 * A live trace of the audible track, blurred back into the Now Playing view.
 *
 * An island in the strict sense: it renders a canvas, polls the transport, and
 * knows nothing about what it sits over. It reads no layout from a neighbour and
 * publishes none, so the docking work can move it without touching this file.
 *
 * ## Why a canvas and not the SVG this started as
 *
 * A `<polyline>` re-serialized every frame is a DOM mutation, a style recalc and
 * a re-rasterization of a filtered element, sixty times a second, on the one
 * element whose entire contribution is atmosphere. The canvas draws the same
 * shape with no DOM involved at all.
 *
 * ## Why it is allowed to be this cheap
 *
 * The blur is a licence. Nothing downstream of a 24px blur at 40% opacity can
 * resolve a bin boundary or a dropped frame, so the loop runs at 30fps over
 * ~1 bin per 8 CSS pixels and spends its effort on *not running* instead: it
 * stops entirely once the shape has decayed, and never starts while the
 * operator has asked for reduced motion.
 */
const playback = usePlaybackStore()
const settings = useSettings()

/** One bin per this many CSS pixels, clamped. Wider bins, softer ribbon. */
const PIXELS_PER_BIN = 8
const MIN_BINS = 24
const MAX_BINS = 160

/**
 * Frame interval. Not 60fps: through the blur the two are indistinguishable, and
 * this is a decoration running underneath a music player that has real work to
 * do on the same thread.
 */
const FRAME_MS = 33

/** Fraction of the half-height the loudest possible bin is allowed to reach. */
const HEADROOM = 0.92

const canvas = ref<HTMLCanvasElement | null>(null)

const reducedMotion = ref(false)
const enabled = computed(
  () => settings.get<boolean>(NOW_PLAYING_WAVEFORM_KEY) && !reducedMotion.value
)

/**
 * Caller-owned, allocated once. `readWaveform` fills it in place precisely so
 * the poll costs nothing per frame.
 */
const samples = new Float32Array(WAVEFORM_SAMPLE_COUNT)

let shaper: WaveformShaper | null = null
let context: CanvasRenderingContext2D | null = null
let frame: number | null = null
let lastFrameMs = 0
let observer: ResizeObserver | null = null
let releaseTheme: (() => void) | null = null
/** Resolved from `--ui-primary`; canvas cannot read a custom property itself. */
let accent = 'currentColor'
let cssWidth = 0
let cssHeight = 0

/**
 * Re-resolve the accent from the token layer.
 *
 * The canvas is the one place in the renderer that cannot consume a CSS custom
 * property directly, so the value is read *out* of the cascade rather than
 * hardcoded here — swapping a theme still touches no component code, which is
 * the M5 criterion. `onThemeChange` is what keeps it honest afterwards.
 */
function readAccent(): void {
  const element = canvas.value
  if (!element) return
  const resolved = getComputedStyle(element).getPropertyValue('--ui-primary').trim()
  if (resolved) accent = resolved
}

function measure(): void {
  const element = canvas.value
  if (!element) return

  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return

  const ratio = window.devicePixelRatio || 1
  cssWidth = rect.width
  cssHeight = rect.height
  element.width = Math.round(rect.width * ratio)
  element.height = Math.round(rect.height * ratio)

  context = element.getContext('2d')
  // Draw in CSS pixels and let the transform handle the backing store, so the
  // geometry below never has to think about the display's scale factor.
  context?.setTransform(ratio, 0, 0, ratio, 0, 0)

  const bins = Math.min(MAX_BINS, Math.max(MIN_BINS, Math.round(rect.width / PIXELS_PER_BIN)))
  // A resize is already a visual discontinuity, so losing the eased state costs
  // nothing the eye can catch.
  shaper = createWaveformShaper({ bins })
}

/**
 * A gradient stop for the falloff mask.
 *
 * Not a colour, despite the shape of it. These stops are only ever consumed
 * under `destination-in`, where the RGB channels are discarded and the alpha is
 * the entire payload — the visible colour comes from `--ui-primary` via
 * `readAccent`. Black is the conventional carrier for an alpha-only stop.
 */
// eslint-disable-next-line fermata/no-raw-colours -- alpha-only mask carrier, see above
const maskAlpha = (alpha: number): string => `rgba(0, 0, 0, ${alpha})`

/** Smooth the outline through the bin tops rather than stepping between them. */
function traceEdge(
  ctx: CanvasRenderingContext2D,
  bins: Float32Array,
  centreY: number,
  halfHeight: number,
  direction: 1 | -1,
  reverse: boolean
): void {
  const count = bins.length
  const step = cssWidth / Math.max(1, count - 1)
  const xAt = (index: number): number => (reverse ? cssWidth - index * step : index * step)
  const yAt = (index: number): number => centreY - direction * bins[index] * halfHeight * HEADROOM

  let previousX = xAt(0)
  let previousY = yAt(0)
  ctx.lineTo(previousX, previousY)
  for (let index = 1; index < count; index += 1) {
    const x = xAt(index)
    const y = yAt(index)
    // Quadratic through the midpoints: each bin top becomes a control point, so
    // the curve passes near every peak without overshooting into the next one.
    ctx.quadraticCurveTo(previousX, previousY, (previousX + x) / 2, (previousY + y) / 2)
    previousX = x
    previousY = y
  }
  ctx.lineTo(previousX, previousY)
}

function draw(): void {
  const ctx = context
  const current = shaper
  if (!ctx || !current) return

  ctx.clearRect(0, 0, cssWidth, cssHeight)
  if (!current.active) return

  const centreY = cssHeight / 2
  const halfHeight = cssHeight / 2

  // Still drawn mirrored even though the lower lobe is clipped away by the
  // stage's `overflow-hidden`. It is not waste: the blur is applied to the
  // canvas before the clip, so filled pixels below the centre line are what keep
  // the ribbon opaque *at* that line. Trace only the upper lobe and the blur
  // feathers the baseline inward, leaving the shape hovering above the footer
  // with a soft gap instead of rising out from behind it.
  ctx.beginPath()
  ctx.moveTo(0, centreY)
  traceEdge(ctx, current.bins, centreY, halfHeight, 1, false)
  traceEdge(ctx, current.bins, centreY, halfHeight, -1, true)
  ctx.closePath()
  ctx.fillStyle = accent
  ctx.fill()

  // Vertical falloff, applied as an alpha mask over the finished shape. Doing it
  // in a second pass keeps the fill above a plain token colour: modulating the
  // accent's own alpha would mean parsing whatever colour space the theme
  // happened to resolve to.
  //
  // Spanning the *visible* half only, top edge to centre line. Beyond its last
  // stop a canvas gradient clamps, so the clipped lower lobe stays fully opaque
  // and goes on doing the job described above. The curve is weighted late so an
  // ordinary peak stays legible and only a full-scale transient sprays out to
  // nothing at its tip.
  const fade = ctx.createLinearGradient(0, 0, 0, centreY)
  fade.addColorStop(0, maskAlpha(0))
  fade.addColorStop(0.35, maskAlpha(0.6))
  fade.addColorStop(1, maskAlpha(1))
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = fade
  ctx.fillRect(0, 0, cssWidth, cssHeight)
  ctx.globalCompositeOperation = 'source-over'
}

function tick(now: number): void {
  frame = requestAnimationFrame(tick)

  if (now - lastFrameMs < FRAME_MS) return
  lastFrameMs = now

  // Nothing to draw into yet — the canvas was hidden or zero-sized when the
  // loop started. Try once to pick up a size, and give up rather than spin.
  if (!shaper) {
    measure()
    if (!shaper) stop()
    return
  }

  const current = shaper
  if (playback.readWaveform(samples)) current.push(samples)
  else current.relax()

  draw()

  // Stop once the shape has decayed *and* nothing is sounding. Both halves
  // matter: a momentarily dry tap under a playing track must not kill the loop,
  // and a paused track must not keep it alive.
  if (!current.active && !playback.isPlaying) stop()
}

function start(): void {
  if (frame !== null || !enabled.value) return
  lastFrameMs = 0
  frame = requestAnimationFrame(tick)
}

function stop(): void {
  if (frame === null) return
  cancelAnimationFrame(frame)
  frame = null
}

function clear(): void {
  context?.clearRect(0, 0, cssWidth, cssHeight)
}

onMounted(() => {
  const element = canvas.value
  if (!element) return

  measure()
  readAccent()

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = motion.matches
  const onMotionChange = (event: MediaQueryListEvent): void => {
    reducedMotion.value = event.matches
  }
  motion.addEventListener('change', onMotionChange)

  observer = new ResizeObserver(() => {
    measure()
    if (frame === null) clear()
  })
  observer.observe(element)

  const disposeTheme = onThemeChange(() => readAccent())
  releaseTheme = () => {
    motion.removeEventListener('change', onMotionChange)
    disposeTheme()
  }

  if (playback.isPlaying) start()
})

watch(
  () => playback.isPlaying,
  (playing) => {
    if (playing) start()
  }
)

watch(enabled, async (on) => {
  if (!on) {
    stop()
    clear()
    return
  }
  // `v-show` has only just flipped `display`, so the element has no box until
  // the DOM catches up and `measure` would read zeros.
  await nextTick()
  measure()
  readAccent()
  if (playback.isPlaying) start()
})

onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  observer = null
  releaseTheme?.()
  releaseTheme = null
})
</script>

<template>
  <!--
    Decoration, and marked as such: nothing here is announced, nothing here is
    clickable, and the transport underneath keeps every hit target it had.
  -->
  <canvas
    v-show="enabled"
    ref="canvas"
    aria-hidden="true"
    class="waveform-ribbon pointer-events-none absolute inset-x-0 w-full"
  />
</template>

<style scoped>
.waveform-ribbon {
  /*
    Height and offset are one decision, so they are written as one. The canvas
    is dropped by exactly half its own height, which puts the mirror's centre
    line on the stage's bottom edge — the footer's top edge. Only the upper lobe
    clears the transport; the lower one is clipped by the stage's
    `overflow-hidden`, which is what makes the ribbon read as rising out from
    behind the bar rather than floating over it.

    Derived with `calc` rather than written as a second number: a height changed
    without the offset following it would unpin the centre line, and the symptom
    — a ribbon sitting slightly too high, or half-swallowed — is the kind of
    thing that gets adjusted by eye forever instead of being fixed.
  */
  --ribbon-height: 14rem;

  height: var(--ribbon-height);
  bottom: calc(var(--ribbon-height) / -2);

  /*
    The blur and the opacity are the whole brief. They are also what buys the
    cheap render loop above: past this filter, a bin boundary is not a thing the
    eye can find.
  */
  opacity: 0.4;
  filter: blur(24px);
}
</style>
