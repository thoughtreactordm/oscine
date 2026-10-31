import { ANALYSIS_BANDS, type AnalysisFrame } from '../analysisFrame'
import type { CoverBitmap } from '../cover'
import { PaletteSlot, type Palette } from '../palette'
import {
  createCoverFit,
  fitCover,
  follow,
  type Cover2D,
  type Draw2D,
  type Effect2DInstance,
  type Quality2D,
  type Stage2D
} from './draw2d'

/**
 * **Halo** — W23-7, D35.9: a radial spectrum ringing a disc of the cover,
 * pulsing on onsets.
 *
 * 2D, `overlay`, `needs.cover`. The host lays it over the wash and scales it by
 * emergence, so this draws the full effect every frame and multiplies only by
 * the flash guard's intensity (D35.8).
 *
 * - **The disc** is the cover, object-cover into a circle at the centre. During
 *   a track change it is the previous and current covers added at `1 − mix` and
 *   `mix` (the wash pass's exact-lerp trick), so the disc crossfades with the
 *   wash under it. It breathes with the bass and swells a little on an onset.
 * - **The ring** is the 64 bands mirrored left and right around the disc, so
 *   the low end sits at the top and the bottom and the picture is symmetric, as
 *   spokes in `--ui-primary`. Behind it a slower echo of the same spectrum is
 *   traced as a closed outline in `--ui-text-highlighted`. The whole ring turns
 *   slowly.
 * - **On an onset** a thin ring leaves the disc's rim and fades as it widens.
 *   The onset is already envelope-shaped by the guard, so it cannot jump.
 *
 * Every colour is a palette slot or the cover; nothing is allocated per frame
 * (the spoke directions are tables made in `create`).
 */

const SPOKES = ANALYSIS_BANDS * 2
const TAU = Math.PI * 2

/** The disc's radius, as a fraction of the stage's shorter side. */
const DISC_RADIUS = 0.15
/** How far the bass and an onset swell the disc. */
const BASS_SWELL = 0.05
const ONSET_SWELL = 0.07
/** The disc's opacity: it is the cover, but it sits in a composition, not a gallery. */
const DISC_ALPHA = 0.92
const RIM_ALPHA = 0.55
/** Gap between the rim and the spokes, and the loudest spoke's length, as fractions of the shorter side. */
const SPOKE_GAP = 0.018
const SPOKE_REACH = 0.24
/** A spoke's width as a fraction of its slot on the rim. */
const SPOKE_FILL = 0.55
const SPOKE_ALPHA = 0.88
/** The slow echo: how long it takes to let go, and how strongly it is drawn. */
const ECHO_RELEASE_SEC = 0.7
const ECHO_ALPHA = 0.35
/** Radians per second the ring turns. One turn every ~2 minutes. */
const TURN_SPEED = 0.05
/** The onset swell's decay. */
const PULSE_TAU_SEC = 0.18
/** The onset ring: below this strength none starts; it travels this far (× shorter side) over its life. */
const RING_MIN_ONSET = 0.15
const RING_LIFE_SEC = 0.9
const RING_TRAVEL = 0.32
const RING_ALPHA = 0.5
/** Bands under this draw no spoke. */
const DRAW_FLOOR = 0.004

export function createHalo<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const cos = new Float32Array(SPOKES)
  const sin = new Float32Array(SPOKES)
  /** Which band each spoke reads: mirrored, low end at the top and the bottom. */
  const bandOf = new Uint8Array(SPOKES)
  for (let spoke = 0; spoke < SPOKES; spoke++) {
    // Spoke 0 points straight up; they run clockwise.
    const angle = (spoke / SPOKES) * TAU - Math.PI / 2
    cos[spoke] = Math.cos(angle)
    sin[spoke] = Math.sin(angle)
    const half = spoke < ANALYSIS_BANDS ? spoke : SPOKES - 1 - spoke
    // 0..63 from the top round to the bottom on each side: the top is bass.
    bandOf[spoke] = half
  }
  const echo = new Float32Array(ANALYSIS_BANDS)
  const fit = createCoverFit()
  const drawEcho = quality !== 'low'

  let width = 0
  let height = 0
  let turn = 0
  let pulse = 0
  let ringAge = RING_LIFE_SEC
  let ringStrength = 0

  function drawDisc(cover: Cover2D<I>, cx: number, cy: number, r: number, alpha: number): void {
    const previous = cover.previous
    const mix = previous ? (cover.mix < 0 ? 0 : cover.mix > 1 ? 1 : cover.mix) : 1
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, TAU)
    ctx.clip()
    if (previous && mix < 1) {
      const drew = drawSlot(previous.bitmap, cx, cy, r, (1 - mix) * alpha)
      // Added, not laid over: the two sum to an exact lerp, as in the wash.
      if (drew) ctx.globalCompositeOperation = 'lighter'
    }
    drawSlot(cover.current.bitmap, cx, cy, r, mix * alpha)
    ctx.restore()
  }

  function drawSlot(
    bitmap: I & CoverBitmap,
    cx: number,
    cy: number,
    r: number,
    alpha: number
  ): boolean {
    if (alpha <= 0) return false
    if (!fitCover(fit, bitmap.width, bitmap.height, cx - r, cy - r, r * 2, r * 2, 1)) return false
    ctx.globalAlpha = alpha
    ctx.drawImage(
      bitmap,
      0,
      0,
      bitmap.width,
      bitmap.height,
      fit.x,
      fit.y,
      bitmap.width * fit.k,
      bitmap.height * fit.k
    )
    return true
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.clearRect(0, 0, width, height)

      // State first, so it advances whether or not there is a surface to draw on.
      turn = (turn + TURN_SPEED * dtSec) % TAU
      const release = follow(dtSec, ECHO_RELEASE_SEC)
      for (let band = 0; band < ANALYSIS_BANDS; band++) {
        const value = audio.spectrum[band]
        echo[band] = value > echo[band] ? value : echo[band] + (value - echo[band]) * release
      }
      pulse += (0 - pulse) * follow(dtSec, PULSE_TAU_SEC)
      if (audio.onset > pulse) pulse = audio.onset
      ringAge += dtSec
      const ringLeft = ringAge < RING_LIFE_SEC ? ringStrength * (1 - ringAge / RING_LIFE_SEC) : 0
      if (audio.onset >= RING_MIN_ONSET && audio.onset > ringLeft) {
        ringAge = 0
        ringStrength = audio.onset
      }
      if (width <= 0 || height <= 0) return

      const intensity = stage.intensity
      const short = width < height ? width : height
      const cx = width / 2
      const cy = height / 2
      const swell = 1 + audio.bass * BASS_SWELL + pulse * ONSET_SWELL * intensity
      const r = short * DISC_RADIUS * swell

      if (stage.cover) drawDisc(stage.cover, cx, cy, r, DISC_ALPHA * intensity)

      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // The rim.
      ctx.globalAlpha = RIM_ALPHA * intensity
      ctx.strokeStyle = palette.css[PaletteSlot.textMuted]
      ctx.lineWidth = Math.max(1, short * 0.003)
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, TAU)
      ctx.stroke()

      const inner = r + short * SPOKE_GAP
      const reach = short * SPOKE_REACH
      const turnCos = Math.cos(turn)
      const turnSin = Math.sin(turn)

      // The echo, behind the spokes: one closed outline.
      if (drawEcho) {
        ctx.globalAlpha = ECHO_ALPHA * intensity
        ctx.strokeStyle = palette.css[PaletteSlot.textHighlighted]
        ctx.lineWidth = Math.max(1, short * 0.002)
        ctx.beginPath()
        for (let spoke = 0; spoke < SPOKES; spoke++) {
          const dirX = cos[spoke] * turnCos - sin[spoke] * turnSin
          const dirY = sin[spoke] * turnCos + cos[spoke] * turnSin
          const radius = inner + echo[bandOf[spoke]] * reach
          if (spoke === 0) ctx.moveTo(cx + dirX * radius, cy + dirY * radius)
          else ctx.lineTo(cx + dirX * radius, cy + dirY * radius)
        }
        ctx.closePath()
        ctx.stroke()
      }

      // The spokes: one path, one stroke.
      ctx.globalAlpha = SPOKE_ALPHA * intensity
      ctx.strokeStyle = palette.css[PaletteSlot.accent]
      ctx.lineWidth = Math.max(1, ((TAU * inner) / SPOKES) * SPOKE_FILL)
      ctx.beginPath()
      for (let spoke = 0; spoke < SPOKES; spoke++) {
        const value = audio.spectrum[bandOf[spoke]]
        if (value < DRAW_FLOOR) continue
        const dirX = cos[spoke] * turnCos - sin[spoke] * turnSin
        const dirY = sin[spoke] * turnCos + cos[spoke] * turnSin
        const outer = inner + value * reach
        ctx.moveTo(cx + dirX * inner, cy + dirY * inner)
        ctx.lineTo(cx + dirX * outer, cy + dirY * outer)
      }
      ctx.stroke()

      // The onset ring.
      if (ringAge < RING_LIFE_SEC) {
        const progress = ringAge / RING_LIFE_SEC
        const alpha = ringStrength * (1 - progress) * (1 - progress) * RING_ALPHA * intensity
        if (alpha > 0.002) {
          ctx.globalAlpha = alpha
          ctx.strokeStyle = palette.css[PaletteSlot.textHighlighted]
          ctx.lineWidth = Math.max(1, short * 0.004 * (1 - progress))
          ctx.beginPath()
          ctx.arc(cx, cy, r + progress * short * RING_TRAVEL, 0, TAU)
          ctx.stroke()
        }
      }

      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.clearRect(0, 0, width, height)
    }
  }
}
