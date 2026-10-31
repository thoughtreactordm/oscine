import { ANALYSIS_BANDS, type AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { follow, type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'

/**
 * **Gyre** — W23-7: the spectrum as arcs orbiting on concentric rings.
 *
 * 2D, `overlay`. The host lays it over the wash and scales it by emergence; this
 * multiplies only by the flash guard's intensity (D35.8).
 *
 * - **Rings.** The 64 bands are split into contiguous groups (they are already
 *   log-spaced), bass innermost. Each ring carries two arcs, opposite each
 *   other, whose length is its group's level.
 * - **Spin.** Neighbouring rings turn in opposite directions, inner ones slowly
 *   and outer ones faster, and a loud ring turns faster still; an onset kicks
 *   every ring on a little. Angles are integrated in clamped time.
 * - **Tails.** Each arc trails fainter, thinner copies of itself set back along
 *   its path by how far it turns in {@link TAIL_LAG_SEC} — a motion blur that
 *   is longer the faster the ring turns, computed rather than remembered.
 *
 * Colours run the primary ramp from `--oscine-color-primary-200` (inside) to
 * `-600` (outside). Every array is made in `create`.
 */

/** The rings' span, as fractions of the shorter side. */
const INNER = 0.1
const OUTER = 0.44
/** A ring's stroke, as a fraction of the gap between rings. */
const STROKE = 0.42
/** Radians per second: the innermost ring's speed, and what each ring outward adds. */
const BASE_SPEED = 0.22
const SPEED_STEP = 0.11
/** A full-level ring turns this much faster; an onset kicks every ring by this much. */
const LEVEL_BOOST = 1.2
const KICK = 1.5
const KICK_TAU_SEC = 0.45
/** Arc length in radians: at silence, and added at full level. */
const MIN_ARC = 0.04
const MAX_ARC = 2.1
/** How quickly an arc's length follows its level: grows fast, shrinks slower. */
const ATTACK_SEC = 0.04
const RELEASE_SEC = 0.22
const TAIL_LAG_SEC = 0.05
const TAIL_FADE = 0.55
const HEAD_ALPHA = 0.9

const RINGS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 8, auto: 12, high: 16 }
const TAILS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 3, auto: 5, high: 6 }

/** The ramp steps the rings run through, inside to outside. */
const RAMP = [
  PaletteSlot.primary200,
  PaletteSlot.primary300,
  PaletteSlot.primary400,
  PaletteSlot.primary500,
  PaletteSlot.primary600
] as const

/** The mean of ring `ring`'s contiguous band group out of `rings`. */
export function ringLevel(spectrum: ArrayLike<number>, ring: number, rings: number): number {
  const from = Math.floor((ring * ANALYSIS_BANDS) / rings)
  const to = Math.max(from + 1, Math.floor(((ring + 1) * ANALYSIS_BANDS) / rings))
  let sum = 0
  for (let band = from; band < to; band++) sum += spectrum[band]
  return sum / (to - from)
}

export function createGyre<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const rings = RINGS_BY_QUALITY[quality]
  const tails = TAILS_BY_QUALITY[quality]
  const angles = new Float64Array(rings)
  const lengths = new Float32Array(rings)
  const speeds = new Float32Array(rings)
  const colours = new Uint8Array(rings)
  for (let ring = 0; ring < rings; ring++) {
    // Start each ring somewhere different, so they never line up at birth.
    angles[ring] = ring * 2.399963
    colours[ring] = RAMP[Math.round((ring / Math.max(1, rings - 1)) * (RAMP.length - 1))]
  }

  let width = 0
  let height = 0
  let kick = 0

  /** Path both of a ring's arcs, centred on `centre`, `length` long. */
  function arcs(cx: number, cy: number, r: number, centre: number, length: number): void {
    const half = length / 2
    ctx.beginPath()
    ctx.arc(cx, cy, r, centre - half, centre + half)
    const opposite = centre + Math.PI
    ctx.moveTo(cx + r * Math.cos(opposite - half), cy + r * Math.sin(opposite - half))
    ctx.arc(cx, cy, r, opposite - half, opposite + half)
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.clearRect(0, 0, width, height)

      const attack = follow(dtSec, ATTACK_SEC)
      const release = follow(dtSec, RELEASE_SEC)
      kick += (0 - kick) * follow(dtSec, KICK_TAU_SEC)
      if (audio.onset > kick) kick = audio.onset
      for (let ring = 0; ring < rings; ring++) {
        const level = ringLevel(audio.spectrum, ring, rings)
        const length = MIN_ARC + level * MAX_ARC
        lengths[ring] += (length - lengths[ring]) * (length > lengths[ring] ? attack : release)
        const direction = ring % 2 === 0 ? 1 : -1
        speeds[ring] =
          direction * (BASE_SPEED + ring * SPEED_STEP) * (1 + level * LEVEL_BOOST + kick * KICK)
        angles[ring] = (angles[ring] + speeds[ring] * dtSec) % (Math.PI * 2)
      }
      if (width <= 0 || height <= 0) return

      const intensity = stage.intensity
      const short = width < height ? width : height
      const cx = width / 2
      const cy = height / 2
      const inner = short * INNER
      const gap = (short * (OUTER - INNER)) / rings
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      for (let ring = 0; ring < rings; ring++) {
        const r = inner + (ring + 0.5) * gap
        const width0 = Math.max(1, gap * STROKE)
        const lag = speeds[ring] * TAIL_LAG_SEC
        ctx.strokeStyle = palette.css[colours[ring]]
        // Tails, furthest back first, so the head lies on top.
        let fade = HEAD_ALPHA
        for (let k = 1; k <= tails; k++) fade *= TAIL_FADE
        for (let k = tails; k >= 1; k--) {
          ctx.globalAlpha = fade * intensity
          ctx.lineWidth = Math.max(1, width0 * (1 - k / (tails + 2)))
          arcs(cx, cy, r, angles[ring] - lag * k, lengths[ring])
          ctx.stroke()
          fade /= TAIL_FADE
        }
        ctx.globalAlpha = HEAD_ALPHA * intensity
        ctx.lineWidth = width0
        arcs(cx, cy, r, angles[ring], lengths[ring])
        ctx.stroke()
      }

      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.clearRect(0, 0, width, height)
    }
  }
}
