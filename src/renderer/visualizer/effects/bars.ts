import { DEFAULT_VISUALIZER_EFFECT } from '@shared/settings'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../analysisFrame'
import type { EffectInstance, EffectTarget, StageInputs, VisualizerEffect } from '../effect'
import { PaletteSlot, type Palette } from '../palette'

/**
 * **Bars** — the first effect and the default (W23-4, D35.9).
 *
 * Mirrored log-spectrum bars rising from a centre line, with peak caps that
 * hold a moment and then fall under gravity. The upper bars are the reading;
 * the lower half is their reflection, dimmer, so the centre line reads as a
 * surface rather than an axis.
 *
 * 2D, `overlay`: the host lays it over the wash and scales it by emergence, so
 * this draws the full effect every frame and multiplies only by the flash
 * guard's intensity. Bodies are `--ui-primary`, caps `--ui-text-highlighted`,
 * the centre line `--ui-text-muted` — no hue of its own (D35.3).
 *
 * Nothing is allocated per frame: the peak state is three typed arrays made in
 * `create`, and every `fillStyle` is a string the palette already holds.
 */

/** Fraction of the half-height the loudest band may reach, leaving room for its cap. */
const HEADROOM = 0.86
/** How long a cap rests on its peak before it starts to fall. */
const PEAK_HOLD_SEC = 0.35
/** Fall acceleration, in half-heights per second². */
const PEAK_GRAVITY = 3.2
/** Gap between bars, as a fraction of each bar's slot. */
const GAP_FRACTION = 0.28
/** The reflection's opacity relative to the bars. */
const REFLECTION_ALPHA = 0.32
const BAR_ALPHA = 0.85
const CAP_ALPHA = 0.9
const LINE_ALPHA = 0.25
/** Bands under this draw nothing, so silence is a bare centre line rather than a stubble of pixels. */
const DRAW_FLOOR = 0.004

function createBars(target: EffectTarget): EffectInstance {
  if (target.surface !== '2d') throw new Error('Bars draws on a 2D surface')
  const ctx = target.context
  const peaks = new Float32Array(ANALYSIS_BANDS)
  const holds = new Float32Array(ANALYSIS_BANDS)
  const speeds = new Float32Array(ANALYSIS_BANDS)
  let width = 0
  let height = 0

  function advancePeaks(spectrum: Float32Array, dtSec: number): void {
    for (let band = 0; band < ANALYSIS_BANDS; band++) {
      const value = spectrum[band]
      if (value >= peaks[band]) {
        peaks[band] = value
        holds[band] = PEAK_HOLD_SEC
        speeds[band] = 0
      } else if (holds[band] > 0) {
        holds[band] -= dtSec
      } else {
        speeds[band] += PEAK_GRAVITY * dtSec
        const fallen = peaks[band] - speeds[band] * dtSec
        peaks[band] = fallen > value ? fallen : value
      }
    }
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
    },

    frame(audio: AnalysisFrame, palette: Palette, stage: StageInputs, dtSec: number): void {
      ctx.clearRect(0, 0, width, height)
      advancePeaks(audio.spectrum, dtSec)
      if (width <= 0 || height <= 0) return

      const intensity = stage.intensity
      const centreY = Math.round(height / 2)
      const reach = (height / 2) * HEADROOM
      const slot = width / ANALYSIS_BANDS
      const barWidth = Math.max(1, Math.floor(slot * (1 - GAP_FRACTION)))
      const inset = Math.floor((slot - barWidth) / 2)
      const capHeight = Math.max(2, Math.round(height * 0.006))
      const capGap = Math.max(1, Math.round(capHeight / 2))

      // The surface the bars stand on.
      ctx.globalAlpha = LINE_ALPHA * intensity
      ctx.fillStyle = palette.css[PaletteSlot.textMuted]
      ctx.fillRect(0, centreY, width, 1)

      // Bodies, then their reflection, in one colour each.
      ctx.fillStyle = palette.css[PaletteSlot.accent]
      ctx.globalAlpha = BAR_ALPHA * intensity
      for (let band = 0; band < ANALYSIS_BANDS; band++) {
        const value = audio.spectrum[band]
        if (value < DRAW_FLOOR) continue
        const barHeight = Math.max(1, Math.round(value * reach))
        ctx.fillRect(Math.round(band * slot) + inset, centreY - barHeight, barWidth, barHeight)
      }
      ctx.globalAlpha = BAR_ALPHA * REFLECTION_ALPHA * intensity
      for (let band = 0; band < ANALYSIS_BANDS; band++) {
        const value = audio.spectrum[band]
        if (value < DRAW_FLOOR) continue
        const barHeight = Math.max(1, Math.round(value * reach))
        ctx.fillRect(Math.round(band * slot) + inset, centreY + 1, barWidth, barHeight)
      }

      // Caps ride above the bars and are mirrored below the line.
      ctx.fillStyle = palette.css[PaletteSlot.textHighlighted]
      ctx.globalAlpha = CAP_ALPHA * intensity
      for (let band = 0; band < ANALYSIS_BANDS; band++) {
        const peak = peaks[band]
        if (peak < DRAW_FLOOR) continue
        const y = centreY - Math.round(peak * reach) - capGap - capHeight
        ctx.fillRect(Math.round(band * slot) + inset, y, barWidth, capHeight)
      }
      ctx.globalAlpha = CAP_ALPHA * REFLECTION_ALPHA * intensity
      for (let band = 0; band < ANALYSIS_BANDS; band++) {
        const peak = peaks[band]
        if (peak < DRAW_FLOOR) continue
        const y = centreY + 1 + Math.round(peak * reach) + capGap
        ctx.fillRect(Math.round(band * slot) + inset, y, barWidth, capHeight)
      }

      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.clearRect(0, 0, width, height)
    }
  }
}

export const BARS: VisualizerEffect = {
  id: DEFAULT_VISUALIZER_EFFECT,
  label: 'Bars',
  surface: '2d',
  emergence: 'overlay',
  create: createBars
}
