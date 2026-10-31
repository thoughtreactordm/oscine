import type { AnalysisFrame } from '../analysisFrame'
import { follow } from './draw2d'

/**
 * The musical drive the 2D effects share (W23-7) — what makes them react with
 * some oomph rather than track the analysis frame literally.
 *
 * The analysis frame is deliberately normalised: the spectrum is auto-gained
 * and the effects auto-scale the waveform, so a loud chorus and a quiet verse
 * draw much the same picture. The drive puts the dynamics back:
 *
 * - **`pulse`** (0..1): the beat. Jumps to an onset's strength and decays over
 *   {@link PULSE_TAU_SEC}. Effects swell, grow and brighten on it. The onset is
 *   already envelope-shaped by the flash guard, so a pulse can't strobe.
 * - **`heat`** (0..1): how hard the section is going — loudness plus how often
 *   onsets land, followed over seconds, plus a lift when the level is climbing
 *   above where it has been. A song picking up heats up; a breakdown cools.
 *   Effects open up on it: longer trails, faster motion, bigger figures.
 * - **`brightness`** (0..1): the spectral centroid across the log bands, a
 *   cheap stand-in for pitch — low for a bass-heavy moment, high for cymbals
 *   and a high melody.
 *
 * Every follower is an exact exponential in `dtSec`, so the drive is
 * frame-rate independent. DOM-free; nothing allocated per update.
 */

export const PULSE_TAU_SEC = 0.2
/** Onset rate: each onset adds its strength; the sum leaks away over this. */
const ONSET_RATE_TAU_SEC = 1.5
/** About this many full-strength onsets a second reads as fully busy. */
const BUSY_ONSETS_PER_SEC = 2.5
/** The level window that maps onto 0..1 of loudness. */
const LOUD_FLOOR = 0.25
const LOUD_SPAN = 0.6
/** Climbing: the level against its own slow average, and how much that adds. */
const LONG_LEVEL_TAU_SEC = 6
const CLIMB_GAIN = 2.5
/** Heat rises over ~1.5 s and falls over ~4 s. */
const HEAT_ATTACK_SEC = 1.5
const HEAT_RELEASE_SEC = 4
const BRIGHTNESS_TAU_SEC = 0.25

export interface Drive {
  readonly pulse: number
  readonly heat: number
  readonly brightness: number
  update(audio: AnalysisFrame, dtSec: number): void
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** The spectral centroid of the log bands, 0 (lowest) .. 1 (highest); 0.5 for silence. */
export function spectralCentroid(spectrum: ArrayLike<number>): number {
  let weighted = 0
  let total = 0
  for (let band = 0; band < spectrum.length; band++) {
    weighted += band * spectrum[band]
    total += spectrum[band]
  }
  if (!(total > 1e-4) || spectrum.length < 2) return 0.5
  return weighted / total / (spectrum.length - 1)
}

export function createDrive(): Drive {
  let pulse = 0
  let heat = 0
  let brightness = 0.5
  let onsetRate = 0
  let longLevel = 0

  return {
    get pulse() {
      return pulse
    },
    get heat() {
      return heat
    },
    get brightness() {
      return brightness
    },

    update(audio, dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      pulse -= pulse * follow(dt, PULSE_TAU_SEC)
      if (audio.onset > pulse) pulse = audio.onset

      // Each onset adds its strength once; the sum leaks, so it reads onsets/second.
      onsetRate -= onsetRate * follow(dt, ONSET_RATE_TAU_SEC)
      if (audio.onset > 0) onsetRate += audio.onset
      const busy = clamp01(onsetRate / (BUSY_ONSETS_PER_SEC * ONSET_RATE_TAU_SEC))
      const loud = clamp01((audio.level - LOUD_FLOOR) / LOUD_SPAN)
      longLevel += (audio.level - longLevel) * follow(dt, LONG_LEVEL_TAU_SEC)
      const climb = clamp01((audio.level - longLevel) * CLIMB_GAIN)
      const target = clamp01(0.45 * loud + 0.45 * busy + 0.3 * climb)
      heat += (target - heat) * follow(dt, target > heat ? HEAT_ATTACK_SEC : HEAT_RELEASE_SEC)

      const centroid = audio.silent ? brightness : spectralCentroid(audio.spectrum)
      brightness += (centroid - brightness) * follow(dt, BRIGHTNESS_TAU_SEC)
    }
  }
}
