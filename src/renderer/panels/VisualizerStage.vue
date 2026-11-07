<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useSettings } from '@renderer/settings'
import { onThemeChange } from '@renderer/theme'
import { usePlaybackStore } from '@renderer/stores/playback'
import { hasArtwork } from '@shared/ipc'
import {
  VISUALIZER_EFFECT_KEY,
  VISUALIZER_PARAMS_KEY,
  VISUALIZER_QUALITY_KEY,
  type VisualizerParamValues,
  type VisualizerQuality
} from '@shared/settings'
import {
  createAnalysisModel,
  MAX_FRAME_DT_SEC,
  type AnalysisFrame
} from '@renderer/visualizer/analysisFrame'
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
import { GL_CONTEXT_ATTRIBUTES } from '@renderer/visualizer/gl/context'
import { createCoverTextures, type CoverTextures } from '@renderer/visualizer/gl/coverTexture'
import { createCanvasLuma, type CanvasLuma } from '@renderer/visualizer/gl/canvasLuma'
import { createLumaReadback, type LumaReadback } from '@renderer/visualizer/gl/lumaReadback'
import { createGlWashPass, type GlWashPass } from '@renderer/visualizer/gl/washPass'
import {
  reportContextLost,
  reportEffectFailure,
  reportTierFailure,
  setDevContext
} from '@renderer/visualizer/glSession'
import { meanLuminance } from '@renderer/visualizer/luminance'
import { createPaletteModel, PALETTE_PROPERTIES, type Palette } from '@renderer/visualizer/palette'
import {
  createQualityGovernor,
  internalSize,
  LOW_FRAME_MS
} from '@renderer/visualizer/qualityBudget'
import { resolveParams, writeParams } from '@renderer/visualizer/params'
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
 * ## The WebGL2 tier (W23-8, D35.6)
 *
 * A WebGL effect gets a context made with `GL_CONTEXT_ATTRIBUTES` on its own
 * canvas, and with it three things this host owns per context: the cover
 * textures (`gl/coverTexture.ts`, the only thing that fills `CoverSlot.texture`),
 * the GPU wash (`gl/washPass.ts`, composed only for `grow` effects — an
 * `overlay` one sits over the 2D wash canvas like any other) and the luminance
 * readback. Its backing store is the budgeted internal target
 * (`qualityBudget.ts`), which the compositor scales to the box; `auto` backs off
 * to `low` on frame time.
 *
 * It fails into 2D, never into a broken stage. No context, a shader that throws
 * or a lost context each go through `glSession.ts`, which takes the effect (or
 * the tier) out of `availableEffects()`; `effect` then re-resolves to a 2D one
 * and the ordinary switch carries the stage there. A loss is the one that
 * cannot wait for the wash — the canvas is already blank — so the CSS wash is
 * restored instantly and the 2D effect grows from it.
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
 * exception is the synchronous 2D luminance sample, kept for a machine with no
 * WebGL2 to sample through (`getImageData` returns a fresh 8×8 `ImageData`),
 * which D35.8 sanctions and which has no allocation-free equivalent there.
 */
const props = defineProps<{
  /** The stage wants the visualizer showing. False starts the way out. */
  active: boolean
}>()

const emit = defineEmits<{
  /**
   * True: the canvas has the wash, fade the CSS one out. False: fade it back
   * in — at once when `instant`, because the canvas has already gone blank.
   */
  wash: [hidden: boolean, instant: boolean]
  /** Off, settled and handed back: safe to unmount. */
  retired: []
}>()

const playback = usePlaybackStore()
const settings = useSettings()

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
const storedParams = computed(() => settings.get<VisualizerParamValues>(VISUALIZER_PARAMS_KEY))
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

let instance: EffectInstance | null = null
let instanceEffect: VisualizerEffect | null = null
/**
 * The live knob values the instance holds (`params.ts`). One object per
 * instance, filled before `create` and written in place on every change after,
 * so the effect reads the new value on its next frame.
 */
let instanceParams: Record<string, number> = {}
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

/** The WebGL tier's per-context state; all null on the 2D tier. */
let gl: WebGL2RenderingContext | null = null
let glCanvas: HTMLCanvasElement | null = null
let glCovers: CoverTextures | null = null
let glWash: GlWashPass | null = null
let glWashInput: WashInput | null = null
let glLuma: LumaReadback | null = null
/** `auto`'s frame-time backoff (D35.6). WebGL only: 2D renders at devicePixelRatio. */
const governor = createQualityGovernor(quality.value)

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
/** The 2D tier's asynchronous sample; made on the first 2D sample, once. */
let canvasLuma: CanvasLuma | null = null
let canvasLumaTried = false
let raf: number | null = null
let lastNow = 0
let frameCount = 0
let observer: ResizeObserver | null = null
/**
 * A live resize (dragging the window or the Tunedeck edge) is held off until the
 * box has been still this long. Resizing a canvas's backing store clears it, and
 * the observer runs after the frame has drawn but before it is painted — so
 * resizing there paints a blank stage on every step of the drag, which is the
 * flashing. Meanwhile the canvases keep their last picture and CSS stretches it
 * to the box (they are `size-full`); a blurred wash and a moving effect hide a
 * brief stretch far better than a strobe.
 */
const RESIZE_SETTLE_MS = 120
let resizeTimer: ReturnType<typeof setTimeout> | null = null
/** The settled size is applied at the top of the next frame, which then draws into it. */
let resizePending = false
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

function onObservedResize(): void {
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    resizeTimer = null
    resizePending = true
    // Inside a frame, not here: the clear and the redraw must share one paint.
    wake()
  }, RESIZE_SETTLE_MS)
}

function measure(): void {
  const element = washCanvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  const ratio = window.devicePixelRatio || 1
  const resized = washPass?.resize(rect.width, rect.height, ratio) ?? false
  glWash?.resize(rect.width, rect.height)
  const effectCanvas = canvas.value
  if (effectCanvas && instance) {
    // 2D renders at devicePixelRatio; WebGL at the budgeted internal target,
    // which the compositor scales up to the box (D35.6).
    let width = Math.round(rect.width * ratio)
    let height = Math.round(rect.height * ratio)
    if (gl) ({ width, height } = internalSize(width, height, governor.profile.capPixels))
    if (effectCanvas.width !== width) effectCanvas.width = width
    if (effectCanvas.height !== height) effectCanvas.height = height
    instance.resize(width, height)
  }
  if (resized) wake()
}

/**
 * The WebGL context for the effect canvas, with the host's per-context state
 * around it. A canvas keeps its context, so two WebGL effects in a row share
 * one; a new element (a 2D ↔ WebGL swap, a return after a loss) starts fresh
 * and re-uploads every cover from the bitmaps the host retained.
 */
function attachGl(element: HTMLCanvasElement): WebGL2RenderingContext | null {
  if (gl && glCanvas === element && !gl.isContextLost()) return gl
  teardownGl()
  const context = element.getContext('webgl2', GL_CONTEXT_ATTRIBUTES)
  if (!context || context.isContextLost()) {
    reportTierFailure()
    return null
  }
  const covers = createCoverTextures(context)
  let wash: GlWashPass
  try {
    wash = createGlWashPass(context, covers)
  } catch (error) {
    // The host's own shaders failing is the tier failing, not one effect.
    covers.dispose()
    console.warn('[visualizer] the WebGL wash failed to build', error)
    reportTierFailure()
    return null
  }
  gl = context
  glCanvas = element
  glCovers = covers
  glWash = wash
  glWashInput = {
    source: wash.texture,
    get look() {
      return look
    }
  }
  glLuma = createLumaReadback(context)
  if (look) wash.setLook(look)
  element.addEventListener('webglcontextlost', onContextLost)
  setDevContext(context)
  return context
}

/** Let go of the WebGL tier's state. Deleting on a lost context is a harmless no-op. */
function teardownGl(): void {
  glCanvas?.removeEventListener('webglcontextlost', onContextLost)
  glLuma?.dispose()
  glWash?.dispose()
  glCovers?.dispose()
  glLuma = null
  glWash = null
  glWashInput = null
  glCovers = null
  glCanvas = null
  gl = null
  setDevContext(null)
}

/**
 * D35.6: context loss is expected. The canvas is already blank, so the CSS
 * wash comes back at once rather than over the handoff; the tier is suspended
 * (or, the second time, off for the session), `effect` re-resolves to the
 * first 2D effect, and that grows from the CSS wash through the ordinary
 * enable path. `webglcontextrestored` (heard by `glSession`) brings the WebGL
 * effect back the same way any switch does.
 */
function onContextLost(event: Event): void {
  event.preventDefault()
  const element = glCanvas
  disposeInstance()
  teardownGl()
  if (element) reportContextLost(element)
  transition.restart()
  if (washHiddenSent) {
    washHiddenSent = false
    emit('wash', false, true)
  }
  // A GPU reset can blank the accelerated 2D wash canvas too.
  washPass?.invalidate()
  setWashOpacity(0)
  setEffectOpacity(0)
  wake()
}

function disposeInstance(): void {
  instance?.dispose()
  instance = null
  instanceEffect = null
  instanceParams = {}
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

  const params = resolveParams(next.params ?? [], storedParams.value[next.id])
  instanceParams = params
  if (next.surface === '2d') {
    const context = element.getContext('2d')
    if (!context) return
    instance = next.create({ surface: '2d', context, quality: quality.value, params })
    stage.wash = washInput
  } else {
    const context = attachGl(element)
    if (!context) return
    try {
      instance = next.create({ surface: 'webgl2', context, quality: quality.value, params })
    } catch (error) {
      // Unavailable for the session; `effect` re-resolves and the switch to a
      // 2D effect runs from the wash, where the stage already is.
      reportEffectFailure(next, error)
      return
    }
    stage.wash = next.emergence === 'grow' ? glWashInput : null
    governor.reset()
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
  teardownGl()
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
 *
 * Asynchronous on both tiers where it can be: the answer lands in
 * `collectLuminance` a frame or two on. A 2D canvas is never read
 * synchronously while a helper context can sample it instead (`canvasLuma.ts`
 * says why); the synchronous read is only for a machine without one.
 */
function sampleLuminance(): void {
  const element = canvas.value
  if (!element || element.width === 0 || element.height === 0) return
  if (glLuma && gl) {
    glLuma.request(gl.drawingBufferWidth, gl.drawingBufferHeight)
    return
  }
  if (!canvasLumaTried) {
    canvasLumaTried = true
    canvasLuma = createCanvasLuma()
  }
  if (canvasLuma?.lost) {
    // Not retried: a GPU reset that takes the helper says the sync read is the safe one.
    canvasLuma.dispose()
    canvasLuma = null
  }
  if (canvasLuma) {
    canvasLuma.request(element)
    return
  }
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
  guard.observeLuminance(meanLuminance(data, false) * effectOpacity)
}

/** The asynchronous readback, once it has landed. */
function collectLuminance(): void {
  const luminance = (gl ? glLuma?.poll() : canvasLuma?.poll()) ?? null
  if (luminance !== null) guard.observeLuminance(luminance * effectOpacity)
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

/**
 * True while a frame runs. A frame can reach `evaluate` — a settled resize's
 * `measure` calls `wake` — and `raf` is null by then, so without this
 * `evaluate` would start a second loop beside the one the frame is about to
 * continue. Every such resize then added a loop for good: three were found
 * running at once, each drawing and sampling every vsync (W23-16).
 */
let ticking = false

function tick(now: number): void {
  ticking = true
  try {
    runFrame(now)
  } finally {
    ticking = false
  }
}

function runFrame(now: number): void {
  raf = null
  const minFrameMs = gl ? governor.profile.minFrameMs : quality.value === 'low' ? LOW_FRAME_MS : 0
  if (lastNow !== 0 && now - lastNow < minFrameMs) {
    raf = requestAnimationFrame(tick)
    return
  }
  // `auto` backs off on the rolling frame time (D35.6); the new cap lands now.
  if (gl && instance && lastNow !== 0 && governor.observe(now - lastNow)) measure()
  const elapsedSec = lastNow === 0 ? 1 / 60 : (now - lastNow) / 1000
  const dt = elapsedSec > MAX_FRAME_DT_SEC ? MAX_FRAME_DT_SEC : elapsedSec
  lastNow = now
  if (styleDirty) readStyle()
  if (resizePending) {
    resizePending = false
    measure()
  }

  const colours = palette.update(dt)
  const covers = cover ? cover.frame(colours, dt) : null
  coverFading = covers?.previous != null
  // Before the handoff a first decode lands whole rather than fading in from the
  // stand-in: the `<img>` is still showing it whole.
  washPass?.compose(covers, washImage, !washHiddenSent)
  if (gl && instanceEffect) {
    const grow = instanceEffect.emergence === 'grow'
    if (grow || instanceEffect.needs?.cover) {
      glCovers?.sync(covers, placeholderActive ? placeholderBitmap : null)
    }
    if (grow) glWash?.compose(covers, washImage, !washHiddenSent)
  }

  transition.update(
    { active: props.active, playing: playback.isPlaying, washReady: washReady() },
    dt
  )
  if (transition.cssWashHidden !== washHiddenSent) {
    washHiddenSent = transition.cssWashHidden
    emit('wash', washHiddenSent, false)
  }
  if (transition.swapDue) swap()

  stage.emergence = transition.emergence
  const current = instance
  if (current && instanceEffect) {
    const read = playback.readWaveform(analysis.waveform)
    const audio = guard.shape(analysis.update(read, dt), dt)
    stage.intensity = guard.intensity
    stage.cover = instanceEffect.needs?.cover ? covers : null
    if (gl) {
      drawGl(current, instanceEffect, audio, colours, dt)
    } else {
      current.frame(audio, colours, stage, dt)
      if (instanceEffect.emergence === 'grow') growDrawn = true
    }
  }
  applyOpacities()

  if (current) {
    collectLuminance()
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
  if (raf === null && shouldRun()) raf = requestAnimationFrame(tick)
}

/**
 * One WebGL frame: the state the effect contract promises, then the effect.
 * A throw marks the effect unavailable (it is never a broken stage); a lost
 * context draws nothing and waits for its event.
 */
function drawGl(
  current: EffectInstance,
  effect: VisualizerEffect,
  audio: AnalysisFrame,
  colours: Palette,
  dt: number
): void {
  const context = gl
  const element = canvas.value
  if (!context || !element || context.isContextLost()) return
  context.bindFramebuffer(context.FRAMEBUFFER, null)
  context.viewport(0, 0, element.width, element.height)
  context.disable(context.BLEND)
  try {
    current.frame(audio, colours, stage, dt)
  } catch (error) {
    reportEffectFailure(effect, error)
    disposeInstance()
    return
  }
  if (effect.emergence === 'grow' && glWash?.drawn) growDrawn = true
}

/**
 * Start the loop if D35.7 says it should run and it is not already running.
 * Inside a frame it is running: the frame re-requests itself at its end.
 */
function evaluate(): void {
  if (ticking || raf !== null || !mounted || !shouldRun()) return
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
    washInput = {
      source: washCanvas.value,
      get look() {
        return look
      }
    }
  }
  cover = createStageCoverSource((slot) => glCovers?.release(slot))
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
    observer = new ResizeObserver(onObservedResize)
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

watch(quality, (next) => {
  governor.setQuality(next)
  resizePending = true
  wake()
})

/** A knob moved: into the instance's own object, seen on its next frame. */
watch(storedParams, (stored) => {
  const current = instanceEffect
  if (!current) return
  writeParams(instanceParams, current.params ?? [], stored[current.id])
  wake()
})

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
  // Before the cover source: its release hook deletes through this.
  teardownGl()
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
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  resizeTimer = null
  releaseTheme?.()
  releaseTheme = null
  motionQuery?.removeEventListener('change', onMotionChange)
  motionQuery = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
  lumaContext = null
  canvasLuma?.dispose()
  canvasLuma = null
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
