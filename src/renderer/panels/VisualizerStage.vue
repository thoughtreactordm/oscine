<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useSettings } from '@renderer/settings'
import { onThemeChange } from '@renderer/theme'
import { usePlaybackStore } from '@renderer/stores/playback'
import { hasArtwork } from '@shared/ipc'
import {
  VISUALIZER_EFFECT_KEY,
  VISUALIZER_QUALITY_KEY,
  type VisualizerQuality
} from '@shared/settings'
import { createAnalysisModel, MAX_FRAME_DT_SEC } from '@renderer/visualizer/analysisFrame'
import { createStageCoverSource, type StageCoverSlot } from '@renderer/visualizer/coverDecode'
import type { CoverSource } from '@renderer/visualizer/coverSource'
import type {
  EffectInstance,
  StageInputs,
  VisualizerEffect,
  WashInput
} from '@renderer/visualizer/effect'
import { createFlashGuard, MIN_SAMPLE_RATE_HZ } from '@renderer/visualizer/flashGuard'
import { resolveEffect, visualizerLoopRuns } from '@renderer/visualizer/gate'
import { createPaletteModel, PALETTE_PROPERTIES } from '@renderer/visualizer/palette'
import { availableEffects } from '@renderer/visualizer/registry'
import {
  createStageTransition,
  DEFAULT_MOTION_SEC,
  parseHoldEmergence,
  transitionDurations
} from '@renderer/visualizer/stageTransition'
import {
  handoffOpacity,
  MOTION_DURATION_PROPERTY,
  parseCssDurationSec,
  parseWashLook,
  washUnderFactor,
  type WashLook
} from '@renderer/visualizer/wash'
import { createWashPass, decodeWashImage, type WashPass } from '@renderer/visualizer/washPass'

/**
 * The stage visualizer host — **W23-4 / W23-5, D35.1 / D35.7 / D35.12**.
 *
 * A panel island: it owns the canvases, the frame loop, the analysis frame
 * (W23-1), the palette and the flash guard (W23-2), the cover input (W23-3),
 * the wash and the transitions, and calls the current effect's
 * `frame(audio, palette, stage, dtSec)` once per rendered frame. It knows
 * nothing about the stage around it. `StageView` decides whether it is wanted
 * (`active`), mounts it in the wash slot, and mirrors the two things it says
 * back: `wash` (fade the CSS wash out, or back in) and `retired` (unmount me).
 *
 * ## Two canvases
 *
 * The **wash canvas** carries the stage's blurred cover, drawn by the 2D wash
 * pass once per cover, theme or size and only blitted by the compositor after
 * that. The **effect canvas** above it is keyed on the effect's surface (a
 * canvas cannot change its context type, D35.1). An `overlay` effect's canvas
 * fades in over the wash with the emergence, and the wash under it eases to its
 * `washUnder`. A `grow` effect draws `stage.wash` itself, so once it has drawn
 * the wash canvas steps aside and the effect canvas carries the handoff instead.
 *
 * ## Every transition passes through the wash (D35.12)
 *
 * The state machine is `visualizer/stageTransition.ts`; this follows it. On
 * enable the wash is drawn and, a frame later, `wash: true` tells the stage to
 * fade its `<img>` out while this canvas fades in, at the opacity that keeps
 * the stacked pair equal to one wash (`handoffOpacity`). On disable the effect
 * settles to the wash first, then the reverse, then `retired`. An effect switch
 * settles, swaps at the wash (replacing the canvas element if the surface
 * changes) and grows back. A pause holds, settles and stops the loop on the wash.
 *
 * ## It costs nothing when nobody is watching (D35.7)
 *
 * The loop runs only while `visualizerLoopRuns` says so — mounted, the window
 * visible, reduced motion off, and playback playing or something still moving:
 * the analysis decaying, a transition under way, a cover decoding or
 * crossfading. `visibilitychange`, the play state and the motion query restart
 * it. Unmounting disposes the effect, the wash and the cover.
 *
 * The per-frame path allocates nothing of its own: `tick` is one function, the
 * stage inputs are one mutable object, opacity strings come from a table built
 * here, and the wash is composed only when what it shows has changed. The one
 * exception is the 2D luminance sample (`getImageData` returns a fresh 8×8
 * `ImageData`), which D35.8 sanctions and which has no allocation-free
 * equivalent on a 2D canvas.
 */
const props = defineProps<{
  /** The stage wants the visualizer showing. False starts the way out. */
  active: boolean
}>()

const emit = defineEmits<{
  /** True: the canvas has the wash, fade the CSS one out. False: fade it back in. */
  wash: [hidden: boolean]
  /** Off, settled and handed back: safe to unmount. */
  retired: []
}>()

const playback = usePlaybackStore()
const settings = useSettings()

/** Frame interval under `quality: 'low'` (D35.6), the ribbon's `FRAME_MS`. */
const LOW_FRAME_MS = 33
/** The luminance downsample's edge (D35.8). */
const LUMA_EDGE = 8
/**
 * Below this frame rate the luminance is sampled every frame, above it every
 * other frame — which keeps the guard over its MIN_SAMPLE_RATE_HZ at 60 fps and
 * under the low tier's 30, with margin either side of 60 for vsync jitter.
 */
const LUMA_EVERY_FRAME_BELOW_HZ = MIN_SAMPLE_RATE_HZ * 1.5
/** Frames the loop runs for after a theme, size or input change, so it is seen. */
const WAKE_FRAMES = 2

/**
 * `VITE_VISUALIZER_HOLD_EMERGENCE=<0..1>` freezes the emergence for W23-15's
 * screenshot checks (D35.12). Dev builds only.
 */
const HOLD_EMERGENCE = import.meta.env.DEV
  ? parseHoldEmergence(import.meta.env.VITE_VISUALIZER_HOLD_EMERGENCE)
  : null

const washCanvas = ref<HTMLCanvasElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const quality = computed(() => settings.get<VisualizerQuality>(VISUALIZER_QUALITY_KEY))
/**
 * The stored id resolved against what can run. An unknown id falls back to the
 * first available effect here, at runtime; the setting itself is left alone.
 */
const effect = computed<VisualizerEffect | null>(() =>
  resolveEffect(availableEffects(), settings.get<string>(VISUALIZER_EFFECT_KEY))
)
/**
 * The effect actually on the canvas. It trails `effect` across a switch: the
 * outgoing one settles into the wash first and the swap happens there.
 */
const shown = shallowRef<VisualizerEffect | null>(effect.value)
/** A canvas cannot change its context type, so the element is keyed on this. */
const surface = computed(() => shown.value?.surface ?? '2d')

const reducedMotion = ref(false)
const hidden = ref(false)
let mounted = false

const analysis = createAnalysisModel()
const guard = createFlashGuard()
const palette = createPaletteModel()
const transition = createStageTransition({ holdEmergence: HOLD_EMERGENCE })
const stage: { -readonly [K in keyof StageInputs]: StageInputs[K] } = {
  emergence: 0,
  intensity: 1,
  wash: null,
  cover: null
}

/** `style.opacity` strings at 1/100 steps, so setting it per frame builds nothing. */
const OPACITY_STEPS = 100
const opacityText: readonly string[] = Array.from({ length: OPACITY_STEPS + 1 }, (_, step) =>
  String(step / OPACITY_STEPS)
)
let effectOpacityStep = -1
let washOpacityStep = -1
/** The effect canvas's opacity as last applied, for the luminance sample. */
let effectOpacity = 0

/** sRGB byte → linear light, for the luminance sample. */
const linearByte = new Float32Array(256)
for (let byte = 0; byte < 256; byte++) {
  const c = byte / 255
  linearByte[byte] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

let instance: EffectInstance | null = null
let instanceEffect: VisualizerEffect | null = null
/** A `grow` effect has drawn (and so carries the wash); until then the wash canvas does. */
let growDrawn = false
let cover: CoverSource<StageCoverSlot> | null = null
let coverFading = false
let washPass: WashPass | null = null
let washInput: WashInput | null = null
let look: WashLook | null = null
let styleDirty = true
let wakeFrames = 0
let washHiddenSent = false
let retiredSent = false

/**
 * The library's placeholder cover. The CSS wash shows it for a track with no
 * art, so the canvas wash has to as well; effects get the synthetic stand-in.
 */
let placeholderActive = false
let placeholderUrl: string | null = null
let placeholderBitmap: ImageBitmap | null = null
let placeholderLoading = false
let placeholderAbort: AbortController | null = null

let lumaContext: CanvasRenderingContext2D | null = null
let raf: number | null = null
let lastNow = 0
let frameCount = 0
let observer: ResizeObserver | null = null
let releaseTheme: (() => void) | null = null
let motionQuery: MediaQueryList | null = null

function onMotionChange(event: MediaQueryListEvent): void {
  reducedMotion.value = event.matches
}

function onVisibilityChange(): void {
  hidden.value = document.hidden
}

/** Re-read the palette's tokens out of the cascade; the model lerps to them. */
function readPalette(): void {
  const element = washCanvas.value
  if (!element) return
  const style = getComputedStyle(element)
  const tokens = new Map<string, string>()
  for (const property of PALETTE_PROPERTIES) {
    tokens.set(property, style.getPropertyValue(property).trim())
  }
  palette.setTarget(tokens)
}

/**
 * The wash's four properties and the motion token. Read in the frame after a
 * theme change rather than in its callback, so the cascade has settled.
 */
function readStyle(): void {
  styleDirty = false
  const element = washCanvas.value
  if (!element) return
  const style = getComputedStyle(element)
  const next = parseWashLook((property) => style.getPropertyValue(property))
  if (next) {
    look = next
    washPass?.setLook(next)
  }
  const motionSec = parseCssDurationSec(style.getPropertyValue(MOTION_DURATION_PROPERTY))
  transition.setDurations(transitionDurations(motionSec ?? DEFAULT_MOTION_SEC))
}

function setEffectOpacity(value: number): void {
  effectOpacity = value
  const element = canvas.value
  if (!element) return
  const step = Math.round((value < 0 ? 0 : value > 1 ? 1 : value) * OPACITY_STEPS)
  if (step === effectOpacityStep) return
  effectOpacityStep = step
  element.style.opacity = opacityText[step]
}

function setWashOpacity(value: number): void {
  const element = washCanvas.value
  if (!element) return
  const step = Math.round((value < 0 ? 0 : value > 1 ? 1 : value) * OPACITY_STEPS)
  if (step === washOpacityStep) return
  washOpacityStep = step
  element.style.opacity = opacityText[step]
}

/** Which layer carries the wash, and how strongly, for where the transition is. */
function applyOpacities(): void {
  const carried = handoffOpacity(transition.handoff, look?.opacity ?? 0)
  const mode = instanceEffect?.emergence ?? 'overlay'
  if (mode === 'grow') {
    setWashOpacity(growDrawn ? 0 : carried)
    setEffectOpacity(growDrawn ? carried : 0)
  } else {
    setWashOpacity(carried * washUnderFactor(stage.emergence, instanceEffect?.washUnder ?? 1))
    setEffectOpacity(stage.emergence)
  }
}

/** What a cover slot shows as wash: its own bitmap, the placeholder, or nothing. */
function washImage(slot: StageCoverSlot): ImageBitmap | null {
  if (!slot.synthetic) return slot.bitmap
  return placeholderActive ? placeholderBitmap : null
}

function washReady(): boolean {
  if (!look || !washPass || !cover) return false
  if (cover.pending || (placeholderActive && placeholderLoading)) return false
  return washPass.drawn
}

function loadPlaceholder(url: string): void {
  if (placeholderUrl === url) return
  placeholderAbort?.abort()
  placeholderBitmap?.close()
  placeholderBitmap = null
  placeholderUrl = url
  placeholderLoading = true
  const abort = new AbortController()
  placeholderAbort = abort
  decodeWashImage(url, abort.signal).then(
    (bitmap) => {
      if (abort.signal.aborted || !mounted) {
        bitmap.close()
        return
      }
      placeholderAbort = null
      placeholderBitmap = bitmap
      placeholderLoading = false
      wake()
    },
    () => {
      if (abort.signal.aborted) return
      // The `<img>` cannot show it either; the wash is simply empty.
      placeholderAbort = null
      placeholderLoading = false
      wake()
    }
  )
}

function setArtwork(url: string | null): void {
  cover?.setArtwork(url)
  placeholderActive = url !== null && !hasArtwork(url)
  if (placeholderActive && url) loadPlaceholder(url)
}

function measure(): void {
  const element = washCanvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  // 2D renders at devicePixelRatio (D35.6); the WebGL budget is W23-8's.
  const ratio = window.devicePixelRatio || 1
  const resized = washPass?.resize(rect.width, rect.height, ratio) ?? false
  const effectCanvas = canvas.value
  if (effectCanvas && instance) {
    const width = Math.round(rect.width * ratio)
    const height = Math.round(rect.height * ratio)
    if (effectCanvas.width !== width) effectCanvas.width = width
    if (effectCanvas.height !== height) effectCanvas.height = height
    instance.resize(width, height)
  }
  if (resized) wake()
}

function disposeInstance(): void {
  instance?.dispose()
  instance = null
  instanceEffect = null
  growDrawn = false
}

/**
 * (Re)create the shown effect on the current effect canvas. Called on mount,
 * at a swap, and once a surface change has replaced the canvas element.
 */
function createInstance(): void {
  disposeInstance()
  const element = canvas.value
  const next = shown.value
  if (!element || !next) return

  if (next.surface === '2d') {
    const context = element.getContext('2d')
    if (!context) return
    instance = next.create({ surface: '2d', context, quality: quality.value })
    stage.wash = washInput
  } else {
    // No WebGL2 effect is registered before W23-8, which owns the probe, the
    // context-loss rules and the GPU wash; until then one here does not draw.
    const gl = element.getContext('webgl2', { premultipliedAlpha: true })
    if (!gl) return
    instance = next.create({ surface: 'webgl2', context: gl, quality: quality.value })
    stage.wash = null
  }
  instanceEffect = next
  analysis.restartClock()
  measure()
}

/** The swap at the bottom of a switch: the outgoing effect is at the wash. */
function swap(): void {
  const next = effect.value
  if (next === shown.value && instance) return
  const surfaceChanges = (next?.surface ?? '2d') !== surface.value
  shown.value = next
  if (!surfaceChanges) {
    createInstance()
    return
  }
  // The keyed canvas is replaced on the next render; the new one starts at
  // opacity 0, which is what the outgoing one was showing.
  disposeInstance()
  // The size observer watches the wash canvas, which is never replaced.
  void nextTick().then(() => {
    if (!mounted) return
    effectOpacityStep = -1
    createInstance()
    evaluate()
  })
}

/**
 * The mean relative luminance of what the effect canvas adds to the stage, for
 * the flash guard (D35.8): an 8×8 downsample, alpha-weighted (it sits over the
 * wash, so a transparent pixel adds nothing) and scaled by the opacity the
 * canvas is shown at.
 */
function sampleLuminance(): void {
  const element = canvas.value
  if (!element || element.width === 0 || element.height === 0) return
  if (!lumaContext) {
    const probe = document.createElement('canvas')
    probe.width = LUMA_EDGE
    probe.height = LUMA_EDGE
    lumaContext = probe.getContext('2d', { willReadFrequently: true })
    if (!lumaContext) return
  }
  lumaContext.clearRect(0, 0, LUMA_EDGE, LUMA_EDGE)
  lumaContext.drawImage(element, 0, 0, LUMA_EDGE, LUMA_EDGE)
  const data = lumaContext.getImageData(0, 0, LUMA_EDGE, LUMA_EDGE).data
  let sum = 0
  for (let index = 0; index < data.length; index += 4) {
    const luminance =
      0.2126 * linearByte[data[index]] +
      0.7152 * linearByte[data[index + 1]] +
      0.0722 * linearByte[data[index + 2]]
    sum += luminance * (data[index + 3] / 255)
  }
  guard.observeLuminance((sum / (LUMA_EDGE * LUMA_EDGE)) * effectOpacity)
}

/** Something is still moving, or owed a frame. */
function busy(): boolean {
  return (
    wakeFrames > 0 ||
    !analysis.frame.silent ||
    !transition.atRest ||
    coverFading ||
    (cover?.pending ?? false) ||
    placeholderLoading
  )
}

function shouldRun(): boolean {
  return visualizerLoopRuns({
    enabled: !retiredSent,
    mounted,
    hidden: hidden.value,
    reducedMotion: reducedMotion.value,
    playing: playback.isPlaying,
    decaying: busy()
  })
}

function tick(now: number): void {
  raf = null
  const minFrameMs = quality.value === 'low' ? LOW_FRAME_MS : 0
  if (lastNow !== 0 && now - lastNow < minFrameMs) {
    raf = requestAnimationFrame(tick)
    return
  }
  const elapsedSec = lastNow === 0 ? 1 / 60 : (now - lastNow) / 1000
  const dt = elapsedSec > MAX_FRAME_DT_SEC ? MAX_FRAME_DT_SEC : elapsedSec
  lastNow = now
  if (styleDirty) readStyle()

  const colours = palette.update(dt)
  const covers = cover ? cover.frame(colours, dt) : null
  coverFading = covers?.previous != null
  // Before the handoff a first decode lands whole rather than fading in from the
  // stand-in: the `<img>` is still showing it whole.
  washPass?.compose(covers, washImage, !washHiddenSent)

  transition.update(
    { active: props.active, playing: playback.isPlaying, washReady: washReady() },
    dt
  )
  if (transition.cssWashHidden !== washHiddenSent) {
    washHiddenSent = transition.cssWashHidden
    emit('wash', washHiddenSent)
  }
  if (transition.swapDue) swap()

  stage.emergence = transition.emergence
  const current = instance
  if (current && instanceEffect) {
    const read = playback.readWaveform(analysis.waveform)
    const audio = guard.shape(analysis.update(read, dt), dt)
    stage.intensity = guard.intensity
    stage.cover = instanceEffect.needs?.cover ? covers : null
    current.frame(audio, colours, stage, dt)
    if (instanceEffect.emergence === 'grow') growDrawn = true
  }
  applyOpacities()

  if (current) {
    // At least MIN_SAMPLE_RATE_HZ samples a second (the W23-2 note): every
    // frame at a capped rate, every other frame at 60 fps.
    frameCount++
    if (dt * LUMA_EVERY_FRAME_BELOW_HZ >= 1 || (frameCount & 1) === 0) sampleLuminance()
  }
  if (wakeFrames > 0) wakeFrames--

  if (transition.retired) {
    if (!retiredSent) {
      retiredSent = true
      emit('retired')
    }
    return
  }
  if (shouldRun()) raf = requestAnimationFrame(tick)
}

/** Start the loop if D35.7 says it should run and it is not already running. */
function evaluate(): void {
  if (raf !== null || !mounted || !shouldRun()) return
  lastNow = 0
  raf = requestAnimationFrame(tick)
}

/** Run at least a couple of frames: the wash or an input changed while settled. */
function wake(): void {
  wakeFrames = WAKE_FRAMES
  evaluate()
}

function stop(): void {
  if (raf === null) return
  cancelAnimationFrame(raf)
  raf = null
}

onMounted(() => {
  mounted = true
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = motionQuery.matches
  motionQuery.addEventListener('change', onMotionChange)
  hidden.value = document.hidden
  document.addEventListener('visibilitychange', onVisibilityChange)

  if (washCanvas.value) {
    washPass = createWashPass(washCanvas.value)
    washInput = { source: washCanvas.value }
  }
  cover = createStageCoverSource()
  setArtwork(playback.nowPlaying?.artwork.large ?? null)

  readPalette()
  readStyle()
  releaseTheme = onThemeChange(() => {
    readPalette()
    styleDirty = true
    wake()
  })
  setWashOpacity(0)
  setEffectOpacity(0)
  createInstance()
  if (washCanvas.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(washCanvas.value)
  }
  measure()
  wake()
})

// A new effect settles the current one into the wash; the swap happens there.
watch(
  () => effect.value,
  (next) => {
    if (next === shown.value) return
    transition.requestSwitch()
    evaluate()
  }
)

watch(
  () => props.active,
  (active) => {
    if (active) retiredSent = false
    wake()
  }
)

watch(
  () => playback.nowPlaying?.artwork.large ?? null,
  (url) => {
    setArtwork(url)
    wake()
  }
)

watch([() => playback.isPlaying, hidden, reducedMotion], () => {
  if (shouldRun()) evaluate()
  else stop()
})

onBeforeUnmount(() => {
  mounted = false
  stop()
  disposeInstance()
  cover?.dispose()
  cover = null
  washPass?.dispose()
  washPass = null
  washInput = null
  stage.wash = null
  placeholderAbort?.abort()
  placeholderAbort = null
  placeholderBitmap?.close()
  placeholderBitmap = null
  observer?.disconnect()
  observer = null
  releaseTheme?.()
  releaseTheme = null
  motionQuery?.removeEventListener('change', onMotionChange)
  motionQuery = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
  lumaContext = null
})
</script>

<template>
  <!--
    Decoration: nothing here is announced or clickable. The wash canvas sits
    under the effect canvas; the effect canvas is keyed on the surface because
    a canvas cannot change its context type (D35.1).
  -->
  <div aria-hidden="true" class="pointer-events-none absolute inset-0">
    <canvas ref="washCanvas" class="visualizer-layer absolute inset-0 size-full" />
    <canvas :key="surface" ref="canvas" class="visualizer-layer absolute inset-0 size-full" />
  </div>
</template>

<style scoped>
.visualizer-layer {
  opacity: 0;
}
</style>
