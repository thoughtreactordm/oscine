<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSettings } from '@renderer/settings'
import { onThemeChange } from '@renderer/theme'
import { usePlaybackStore } from '@renderer/stores/playback'
import {
  VISUALIZER_EFFECT_KEY,
  VISUALIZER_QUALITY_KEY,
  type VisualizerQuality
} from '@shared/settings'
import { createAnalysisModel, MAX_FRAME_DT_SEC } from '@renderer/visualizer/analysisFrame'
import { createStageCoverSource, type StageCoverSlot } from '@renderer/visualizer/coverDecode'
import type { CoverSource } from '@renderer/visualizer/coverSource'
import type { EffectInstance, StageInputs, VisualizerEffect } from '@renderer/visualizer/effect'
import { createEmergence } from '@renderer/visualizer/emergence'
import { createFlashGuard, MIN_SAMPLE_RATE_HZ } from '@renderer/visualizer/flashGuard'
import { resolveEffect, visualizerLoopRuns } from '@renderer/visualizer/gate'
import { createPaletteModel, PALETTE_PROPERTIES } from '@renderer/visualizer/palette'
import { availableEffects } from '@renderer/visualizer/registry'

/**
 * The stage visualizer host — **W23-4, D35.1 / D35.7**.
 *
 * A panel island: it owns the canvas, the frame loop, the analysis frame
 * (W23-1), the palette and the flash guard (W23-2) and the cover input (W23-3),
 * and calls the current effect's `frame(audio, palette, stage, dtSec)` once per
 * rendered frame. It knows nothing about the stage around it; `StageView`
 * decides whether it is mounted at all (the setting, Zen's override, the width
 * gate and reduced motion) and mounts it in the wash slot.
 *
 * ## Until W23-5
 *
 * The CSS wash stays underneath and this canvas is a transparent overlay that
 * fades in with the emergence. The host draws no wash of its own yet, so
 * `StageInputs.wash` is null and only `overlay` effects make sense.
 *
 * ## It costs nothing when nobody is watching (D35.7)
 *
 * The loop runs only while `visualizerLoopRuns` says so — mounted, the window
 * visible, reduced motion off, and playback playing or the picture still
 * settling. A pause holds the effect for a few seconds, eases it back to the
 * wash and then stops; `visibilitychange`, the play state and the motion query
 * restart it. Unmounting disposes the effect and the cover.
 *
 * The per-frame path allocates nothing of its own: `tick` is one function, the
 * stage inputs are one mutable object, opacity strings come from a table built
 * here. The one exception is the 2D luminance sample (`getImageData` returns a
 * fresh 8×8 `ImageData`), which D35.8 sanctions and which has no
 * allocation-free equivalent on a 2D canvas.
 */
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

const canvas = ref<HTMLCanvasElement | null>(null)

const quality = computed(() => settings.get<VisualizerQuality>(VISUALIZER_QUALITY_KEY))
/**
 * The stored id resolved against what can run. An unknown id falls back to the
 * first available effect here, at runtime; the setting itself is left alone.
 */
const effect = computed<VisualizerEffect | null>(() =>
  resolveEffect(availableEffects(), settings.get<string>(VISUALIZER_EFFECT_KEY))
)
/** A canvas cannot change its context type, so the element is keyed on this. */
const surface = computed(() => effect.value?.surface ?? '2d')

const reducedMotion = ref(false)
const hidden = ref(false)
let mounted = false

const analysis = createAnalysisModel()
const guard = createFlashGuard()
const palette = createPaletteModel()
const emergence = createEmergence()
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
let opacityStep = -1

/** sRGB byte → linear light, for the luminance sample. */
const linearByte = new Float32Array(256)
for (let byte = 0; byte < 256; byte++) {
  const c = byte / 255
  linearByte[byte] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

let instance: EffectInstance | null = null
let instanceEffect: VisualizerEffect | null = null
let context2d: CanvasRenderingContext2D | null = null
let cover: CoverSource<StageCoverSlot> | null = null
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
  const element = canvas.value
  if (!element) return
  const style = getComputedStyle(element)
  const tokens = new Map<string, string>()
  for (const property of PALETTE_PROPERTIES) {
    tokens.set(property, style.getPropertyValue(property).trim())
  }
  palette.setTarget(tokens)
}

function setOpacity(value: number): void {
  const element = canvas.value
  if (!element) return
  const step = Math.round((value < 0 ? 0 : value > 1 ? 1 : value) * OPACITY_STEPS)
  if (step === opacityStep) return
  opacityStep = step
  element.style.opacity = opacityText[step]
}

function measure(): void {
  const element = canvas.value
  if (!element || !instance) return
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  // 2D effects render at devicePixelRatio (D35.6); the WebGL budget is W23-8's.
  const ratio = window.devicePixelRatio || 1
  const width = Math.round(rect.width * ratio)
  const height = Math.round(rect.height * ratio)
  if (element.width !== width) element.width = width
  if (element.height !== height) element.height = height
  instance.resize(width, height)
}

function disposeInstance(): void {
  instance?.dispose()
  instance = null
  instanceEffect = null
}

/**
 * (Re)create the effect on the current canvas. Called when the canvas element
 * is replaced (a surface change) and when the effect changes on one surface.
 */
function createInstance(): void {
  disposeInstance()
  const element = canvas.value
  const next = effect.value
  if (!element || !next) return

  if (next.surface === '2d') {
    context2d = element.getContext('2d')
    if (!context2d) return
    instance = next.create({ surface: '2d', context: context2d, quality: quality.value })
  } else {
    // No WebGL2 effect is registered before W23-8, which owns the probe and the
    // context-loss rules; until then a WebGL effect here simply does not draw.
    const gl = element.getContext('webgl2', { premultipliedAlpha: true })
    if (!gl) return
    instance = next.create({ surface: 'webgl2', context: gl, quality: quality.value })
  }
  instanceEffect = next
  analysis.restartClock()

  if (next.needs?.cover) {
    cover ??= createStageCoverSource()
    cover.setArtwork(playback.nowPlaying?.artwork.large ?? null)
  } else {
    cover?.dispose()
    cover = null
  }
  measure()
}

/**
 * The mean relative luminance of what this canvas adds to the stage, for the
 * flash guard (D35.8): an 8×8 downsample, alpha-weighted (it sits over the wash,
 * so a transparent pixel adds nothing) and scaled by the emergence the canvas is
 * shown at.
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
  guard.observeLuminance((sum / (LUMA_EDGE * LUMA_EDGE)) * stage.emergence)
}

function decaying(): boolean {
  return !analysis.frame.silent || !emergence.atRest
}

function shouldRun(): boolean {
  return visualizerLoopRuns({
    enabled: effect.value !== null,
    mounted,
    hidden: hidden.value,
    reducedMotion: reducedMotion.value,
    playing: playback.isPlaying,
    decaying: decaying()
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

  const current = instance
  if (current) {
    const read = playback.readWaveform(analysis.waveform)
    const audio = guard.shape(analysis.update(read, dt), dt)
    const colours = palette.update(dt)
    stage.emergence = emergence.update(playback.isPlaying, dt)
    stage.intensity = guard.intensity
    stage.cover = cover ? cover.frame(colours, dt) : null
    current.frame(audio, colours, stage, dt)
    setOpacity(stage.emergence)

    // At least MIN_SAMPLE_RATE_HZ samples a second (the W23-2 note): every
    // frame at a capped rate, every other frame at 60 fps.
    frameCount++
    if (dt * LUMA_EVERY_FRAME_BELOW_HZ >= 1 || (frameCount & 1) === 0) sampleLuminance()
  }

  if (shouldRun()) raf = requestAnimationFrame(tick)
}

/** Start the loop if D35.7 says it should run and it is not already running. */
function evaluate(): void {
  if (raf !== null || !instance || !shouldRun()) return
  lastNow = 0
  raf = requestAnimationFrame(tick)
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

  readPalette()
  releaseTheme = onThemeChange(() => readPalette())
  setOpacity(0)
  createInstance()
  if (canvas.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(canvas.value)
  }
  evaluate()
})

// A new surface replaces the canvas element (it is keyed); a new effect on the
// same surface only re-creates the effect.
watch(
  () => effect.value,
  async (next) => {
    if (next === instanceEffect) return
    stop()
    await nextTick()
    if (!mounted) return
    if (canvas.value && observer) {
      observer.disconnect()
      observer.observe(canvas.value)
    }
    opacityStep = -1
    setOpacity(stage.emergence)
    createInstance()
    evaluate()
  }
)

watch(
  () => playback.nowPlaying?.artwork.large ?? null,
  (url) => cover?.setArtwork(url)
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
    Decoration: nothing here is announced or clickable. Keyed on the surface
    because a canvas cannot change its context type (D35.1).
  -->
  <canvas
    :key="surface"
    ref="canvas"
    aria-hidden="true"
    class="visualizer-stage pointer-events-none absolute inset-0 size-full"
  />
</template>

<style scoped>
.visualizer-stage {
  opacity: 0;
}
</style>
