import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { multiplierParam, resolveParams, type EffectParamSpec, type EffectParams } from '../params'
import { follow, type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'
import { createDrive } from './drive'

/**
 * **Phase** — W23-14 (D35.9, D35.10): an X/Y scope of left against right.
 *
 * 2D, `overlay`, `needs.stereo`. The only stereo effect and the first consumer
 * of the stereo tap: it reads `stage.stereo`, which the host fills only while
 * Phase is the instantiated effect.
 *
 * - **The mapping** ({@link mapPhasePoints}) is the goniometer's: the L/R plane
 *   rotated 45°, so `x = (R − L)/√2` and `y = (L + R)/√2`. Mono content (L = R)
 *   draws a vertical line, a hard-left signal the up-left diagonal, a
 *   hard-right one the up-right diagonal, and anti-phase content a horizontal
 *   line; wide stereo opens out into a cloud between them.
 * - **The gain** follows the sweep's peak (fast attack, slow release, with a
 *   floor so a near-silent passage stays small), so a quiet master still fills
 *   the scope; a beat swells it on top.
 * - **Persistence** is phosphor-style but not a self-fading canvas (8-bit
 *   ghosts, frame-rate-dependent fade): a sweep is laid into a preallocated ring
 *   every {@link STEP_SEC} of clamped time, already scaled, and every sweep is
 *   redrawn each frame at `(1 − age/life)²`, its age advanced by `dtSec`. The
 *   live sweep is drawn on top at full strength. A frame whose read answered
 *   nothing lays no sweep and draws no live one, so a pause fades out.
 *
 * Every colour is a palette entry and every alpha is multiplied by
 * `stage.intensity` (D35.8). DOM-free; nothing allocated per frame.
 */

/** A sweep is laid this often, whatever the frame rate. */
const STEP_SEC = 1 / 30
/** How long a sweep glows, at the untuned persistence. */
const LIFE_SEC = 0.4
/** The persistence knob's range: its top sizes the ring. */
const PERSISTENCE_MIN = 0.25
const PERSISTENCE_MAX = 3
/** A beat swells the scope and thickens the trace; the heat lengthens the glow. */
const PULSE_GROW = 0.14
const PULSE_WIDTH = 1.4
const HEAT_LIFE = 0.6
/** Enough slots that the longest glow (top persistence, full heat) never overwrites a lit sweep. */
const MAX_SWEEPS = Math.ceil((LIFE_SEC * PERSISTENCE_MAX * (1 + HEAT_LIFE)) / STEP_SEC) + 1
/** Points per sweep, by quality: every 4th, 2nd or every one of the 1024 samples… */
const STRIDE_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 4, auto: 2, high: 1 }
/** …and history sweeps keep half that, since they are faint and many. */
const HISTORY_DECIMATION = 2
/** The scope's radius as a fraction of the shorter side. */
const RADIUS = 0.42
/** The gain aims the peak here, and never amplifies a peak under the floor further. */
const TARGET_PEAK = 0.9
const PEAK_FLOOR = 0.12
const PEAK_ATTACK_SEC = 0.03
const PEAK_RELEASE_SEC = 1.4
/** A point may overshoot the circle this far before it is clipped. */
const MAX_EXTENT = 1.15
/** Line width at the untuned look, per 400 px of the shorter side. */
const LINE_WIDTH = 1.4
const LIVE_ALPHA = 0.95
const HISTORY_ALPHA = 0.55
const GRATICULE_ALPHA = 0.16
const SQRT1_2 = Math.SQRT1_2

export const PHASE_KNOBS: readonly EffectParamSpec[] = [
  multiplierParam('persistence', 'Persistence', 'How long the trace glows after it is drawn.', {
    min: PERSISTENCE_MIN,
    max: PERSISTENCE_MAX
  }),
  multiplierParam('size', 'Size', 'How large the scope is.', { min: 0.5, max: 1.4 }),
  multiplierParam(
    'beat',
    'Beat swell',
    'How hard a beat swells the scope and thickens the trace.',
    {
      min: 0,
      max: 2
    }
  )
]

/**
 * Map stereo samples onto the scope: every `stride`-th sample pair lands in
 * `out` as `x, y` (y up), `x = (R − L)/√2` and `y = (L + R)/√2`, scaled by
 * `gain` and clipped to ±`limit`. Returns the number of points written and
 * never writes past `out`. The largest unscaled `|x|` or `|y|` among them is left
 * in `peak[0]` when `peak` is given, for the gain follower.
 */
export function mapPhasePoints(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  stride: number,
  out: Float32Array,
  gain = 1,
  limit = Infinity,
  peak?: Float32Array
): number {
  const step = stride >= 1 ? Math.floor(stride) : 1
  const length = Math.min(left.length, right.length)
  let count = 0
  let largest = 0
  for (let index = 0; index < length && count * 2 + 1 < out.length; index += step) {
    const l = left[index]
    const r = right[index]
    const x = (r - l) * SQRT1_2
    const y = (l + r) * SQRT1_2
    const ax = x < 0 ? -x : x
    const ay = y < 0 ? -y : y
    if (ax > largest) largest = ax
    if (ay > largest) largest = ay
    const sx = x * gain
    const sy = y * gain
    out[count * 2] = sx > limit ? limit : sx < -limit ? -limit : sx
    out[count * 2 + 1] = sy > limit ? limit : sy < -limit ? -limit : sy
    count++
  }
  if (peak) peak[0] = largest
  return count
}

export function createPhase<I>(
  ctx: Draw2D<I>,
  quality: Quality2D,
  knobs: EffectParams = resolveParams(PHASE_KNOBS, undefined)
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const stride = STRIDE_BY_QUALITY[quality]
  const livePoints = Math.ceil(1024 / stride)
  const historyStride = stride * HISTORY_DECIMATION
  const historyPoints = Math.ceil(1024 / historyStride)
  const live = new Float32Array(livePoints * 2)
  /** Each sweep: `historyPoints` x, y pairs in scope units (±1 is the circle). */
  const sweeps = new Float32Array(MAX_SWEEPS * historyPoints * 2)
  const sweepCounts = new Uint16Array(MAX_SWEEPS)
  const ages = new Float32Array(MAX_SWEEPS)
  const peakOut = new Float32Array(1)
  const drive = createDrive()

  let width = 0
  let height = 0
  /** The next ring slot to lay a sweep into, and how many slots hold one. */
  let head = 0
  let filled = 0
  let carry = 0
  let envelope = PEAK_FLOOR

  function strokeSweep(
    points: Float32Array,
    offset: number,
    count: number,
    cx: number,
    cy: number,
    radius: number
  ): void {
    if (count < 2) return
    ctx.beginPath()
    ctx.moveTo(cx + points[offset] * radius, cy - points[offset + 1] * radius)
    for (let point = 1; point < count; point++) {
      const at = offset + point * 2
      ctx.lineTo(cx + points[at] * radius, cy - points[at + 1] * radius)
    }
    ctx.stroke()
  }

  return {
    resize(nextWidth, nextHeight) {
      width = nextWidth > 0 ? nextWidth : 0
      height = nextHeight > 0 ? nextHeight : 0
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      drive.update(audio, dt)
      const life = LIFE_SEC * knobs.persistence * (1 + drive.heat * HEAT_LIFE)
      for (let slot = 0; slot < filled; slot++) ages[slot] += dt

      // The gain follows this frame's peak; the live sweep is mapped under it.
      const stereo = stage.stereo
      const isLive = !!stereo && stereo.live
      let liveCount = 0
      if (stereo && isLive) {
        mapPhasePoints(stereo.left, stereo.right, stride, live, 1, Infinity, peakOut)
        const peak = peakOut[0]
        envelope +=
          (peak - envelope) * follow(dt, peak > envelope ? PEAK_ATTACK_SEC : PEAK_RELEASE_SEC)
        const gain = TARGET_PEAK / (envelope > PEAK_FLOOR ? envelope : PEAK_FLOOR)
        liveCount = mapPhasePoints(stereo.left, stereo.right, stride, live, gain, MAX_EXTENT)

        carry += dt
        if (carry >= STEP_SEC) {
          // One sweep per frame at most: a slow frame has only one buffer to lay.
          carry %= STEP_SEC
          const offset = head * historyPoints * 2
          sweepCounts[head] = mapPhasePoints(
            stereo.left,
            stereo.right,
            historyStride,
            sweeps.subarray(offset, offset + historyPoints * 2),
            gain,
            MAX_EXTENT
          )
          ages[head] = 0
          head = (head + 1) % MAX_SWEEPS
          if (filled < MAX_SWEEPS) filled++
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (width === 0 || height === 0) return

      const intensity = stage.intensity > 0 ? stage.intensity : 0
      const short = Math.min(width, height)
      const unit = short / 400
      const pulse = drive.pulse * knobs.beat
      const radius = short * RADIUS * knobs.size * (1 + pulse * PULSE_GROW)
      const cx = width / 2
      const cy = height / 2

      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // The graticule: the M axis and the L and R diagonals, faint.
      ctx.globalAlpha = GRATICULE_ALPHA * intensity
      ctx.strokeStyle = palette.css[PaletteSlot.textMuted]
      ctx.lineWidth = unit
      const diagonal = radius * SQRT1_2
      ctx.beginPath()
      ctx.moveTo(cx, cy + radius)
      ctx.lineTo(cx, cy - radius)
      ctx.moveTo(cx - diagonal, cy - diagonal)
      ctx.lineTo(cx + diagonal, cy + diagonal)
      ctx.moveTo(cx + diagonal, cy - diagonal)
      ctx.lineTo(cx - diagonal, cy + diagonal)
      ctx.stroke()

      ctx.globalCompositeOperation = 'lighter'
      const width0 = unit * LINE_WIDTH * (1 + pulse * PULSE_WIDTH)

      // History, oldest first, so the newer sweeps land on top.
      ctx.strokeStyle = palette.css[PaletteSlot.primary300]
      ctx.lineWidth = width0
      for (let n = filled; n > 0; n--) {
        const slot = (head - n + MAX_SWEEPS) % MAX_SWEEPS
        const age = ages[slot]
        if (!(age < life)) continue
        const fade = 1 - age / life
        ctx.globalAlpha = HISTORY_ALPHA * fade * fade * intensity
        strokeSweep(sweeps, slot * historyPoints * 2, sweepCounts[slot], cx, cy, radius)
      }

      if (liveCount > 1) {
        ctx.strokeStyle = palette.css[PaletteSlot.accent]
        ctx.globalAlpha = LIVE_ALPHA * intensity
        strokeSweep(live, 0, liveCount, cx, cy, radius)
      }
      ctx.restore()
    },

    dispose() {
      filled = 0
      head = 0
    }
  }
}
