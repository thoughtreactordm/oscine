import type { WaveformBuffer } from '../audio/AudioEngine'
import { ANALYSIS_BANDS, MAX_FRAME_DT_SEC, type AnalysisFrame } from './analysisFrame'

/**
 * The stage visualizer's flash guard — **W23-2, D35.8, R17's mitigation**.
 *
 * Whatever the music does, the stage must not flash faster than three times a
 * second (WCAG 2.3.1's general flash threshold). An onset-driven brightness
 * pulse on a beat-heavy track does exactly that by default, so this is a pure
 * model in the host rather than a convention each effect is trusted to keep. It
 * has two halves:
 *
 * - **An envelope with a minimum attack.** {@link FlashGuard.shape} turns the
 *   analysis frame into the one effects actually read: `onset`, the band
 *   energies, `level` and every spectrum band may rise no faster than
 *   {@link MIN_ATTACK_SEC} from rest to peak, and never more than
 *   {@link MAX_RISE_PER_FRAME} in one frame however long the frame was. A
 *   one-frame onset impulse becomes a pulse that ramps up, holds its peak and
 *   decays. Falls pass straight through; only a rise can flash.
 * - **A luminance monitor.** The host samples the mean relative luminance of a
 *   tiny downsample of the rendered frame and passes it to {@link
 *   FlashGuard.observeLuminance}. A transition is a run of
 *   {@link FLASH_DETECT_DELTA} or more in one direction (hysteresis, so a slow
 *   ramp counts once however many samples it spans) whose darker end is under
 *   {@link FLASH_DARK_LIMIT}. A flash is a pair of opposing transitions. Once a
 *   one-second window holds the transitions of {@link MAX_FLASHES_PER_SEC}
 *   flashes, `intensity` is cut — at once, and by enough that the next swing
 *   lands under the threshold. It climbs back at {@link RECOVERY_PER_SEC} only
 *   after {@link RECOVERY_HOLD_SEC} in which the swings, scaled back up by the
 *   cut, would no longer have been flashes: recovery waits for the strobe
 *   passage to end, not merely for the cut to have hidden it.
 *
 * **Sampling has a floor**, {@link MIN_SAMPLE_RATE_HZ}. The analysis model's
 * 100 ms onset refractory caps an onset strobe at 10 Hz, and sampling at 20 Hz
 * aliases an 8–10 Hz strobe badly enough that the monitor reads its swings at
 * well under half their size on screen. The tests pin both rates.
 *
 * **Always on.** Every threshold is a constant here. There is no descriptor,
 * flag or per-effect opt-out, and {@link FlashGuard.intensity} is the only
 * source of the multiplier effects are required to put into their output.
 *
 * A palette change is not a flash: it is one monotonic transition over the
 * palette's 600 ms lerp, and a single transition never counts as one.
 *
 * `@renderer`-free, DOM-free and allocation-free per frame.
 */

/** No shaped value goes from rest to peak in less than this. */
export const MIN_ATTACK_SEC = 0.08
/** …nor by more than this in one frame, however long the frame (a 10 fps stall included). */
export const MAX_RISE_PER_FRAME = 0.5
/** How fast a shaped onset decays once it has reached its peak. */
export const ONSET_RELEASE_SEC = 0.12

/** WCAG 2.3.1: a flash is a swing of 10 % of the maximum relative luminance. */
export const FLASH_LUMINANCE_DELTA = 0.1
/**
 * The swing the monitor counts. Under {@link FLASH_LUMINANCE_DELTA} on purpose:
 * the host only samples every few frames, so the peak it sees can be lower than
 * the peak on screen, and the guard should act before the real threshold does.
 */
export const FLASH_DETECT_DELTA = 0.08
/** WCAG 2.3.1: a swing whose darker end is above this doesn't count. */
export const FLASH_DARK_LIMIT = 0.8
/** The host must feed {@link FlashGuard.observeLuminance} at least this often. */
export const MIN_SAMPLE_RATE_HZ = 30

/** WCAG 2.3.1's general flash threshold. */
export const MAX_FLASHES_PER_SEC = 3
export const FLASH_WINDOW_SEC = 1

/** The cut aims the next swing at this fraction of the detect threshold. */
const DAMP_HEADROOM = 0.5
/** A cut is at least this deep… */
const DAMP_MAX_FACTOR = 0.5
/** …and never takes intensity below this. */
export const MIN_INTENSITY = 0.1
/** Calm needed after the last cut before intensity climbs again. */
export const RECOVERY_HOLD_SEC = 1
/** How fast intensity climbs back, per second. Slow: a strobe passage tends to resume. */
export const RECOVERY_PER_SEC = 0.2

/**
 * While damped, a swing this small still counts as the strobe persisting, so
 * the scaled threshold can't sink into frame-to-frame noise.
 */
const PERSIST_FLOOR = 0.02

/** Comfortably more transitions than a one-second window can hold at 60 fps. */
const TRANSITION_CAPACITY = 128

/**
 * Counts luminance transitions over a sliding {@link FLASH_WINDOW_SEC} window.
 *
 * A transition is a run in one direction of at least `threshold` whose darker
 * end is under {@link FLASH_DARK_LIMIT}. Turning needs a retreat of `threshold`
 * from the furthest point (hysteresis), so a slow ramp is one transition however
 * many samples it spans, and jitter under the threshold is none.
 */
interface TransitionCounter {
  /** Transitions in the window as of the last sample. */
  readonly count: number
  /** Feed a sample. Returns the swing a newly counted transition is sized by, else 0. */
  observe(y: number, threshold: number, nowSec: number): number
  reset(): void
}

function createTransitionCounter(): TransitionCounter {
  // `extreme` is the furthest the signal has gone in `direction` (+1 rising, −1
  // falling, 0 not yet known) since `anchor`, the last turning point.
  let started = false
  let direction = 0
  let anchor = 0
  let extreme = 0
  /** Whether the current run has been counted yet. */
  let counted = false
  /** The size of the last completed run. */
  let lastSwing = 0
  /** A ring of transition times, oldest at `head`. */
  const times = new Float64Array(TRANSITION_CAPACITY)
  let head = 0
  let count = 0

  function prune(nowSec: number): void {
    while (count > 0 && nowSec - (times[head] ?? 0) >= FLASH_WINDOW_SEC) {
      head = (head + 1) % TRANSITION_CAPACITY
      count--
    }
  }

  return {
    get count() {
      return count
    },
    observe(y, threshold, nowSec) {
      prune(nowSec)
      if (!started) {
        started = true
        anchor = extreme = y
        return 0
      }
      if (direction === 0) {
        if (Math.abs(y - anchor) < threshold) return 0
        direction = y > anchor ? 1 : -1
        extreme = y
      } else if ((y - extreme) * direction >= 0) {
        extreme = y // still going the same way
      } else if (Math.abs(y - extreme) >= threshold) {
        // Turned: `extreme` was a turning point, and the run back from it is a
        // transition of its own.
        lastSwing = Math.abs(extreme - anchor)
        anchor = extreme
        extreme = y
        direction = -direction
        counted = false
      }
      // A run counts once, as soon as it is both big enough and dark enough at
      // one end — a fall from near-white only qualifies once it gets under the
      // dark limit, however far it had already come.
      const run = Math.abs(extreme - anchor)
      const darker = anchor < extreme ? anchor : extreme
      if (counted || run < threshold || darker >= FLASH_DARK_LIMIT) return 0
      counted = true
      times[(head + count) % TRANSITION_CAPACITY] = nowSec
      if (count < TRANSITION_CAPACITY) count++
      else head = (head + 1) % TRANSITION_CAPACITY
      return Math.max(lastSwing, run)
    },
    reset() {
      started = false
      direction = 0
      anchor = 0
      extreme = 0
      counted = false
      lastSwing = 0
      head = 0
      count = 0
    }
  }
}

export interface FlashGuard {
  /**
   * Advance one rendered frame and shape `audio` into the frame effects read.
   * Returns the guard's own frame — the same object every call — sharing
   * `waveform` with the input. Its `onset` is an envelope, not an event: it is
   * non-zero for the whole pulse, so `onset > 0` no longer marks one frame.
   */
  shape(audio: AnalysisFrame, dtSec: number): AnalysisFrame
  /**
   * The mean relative luminance (0..1) of the frame just rendered, from the
   * host's downsample. Call it whenever a sample is taken — at least
   * {@link MIN_SAMPLE_RATE_HZ} times a second (every other frame at 60 fps). A
   * sample may lag its frame by a frame or two (an async `readPixels`); what
   * matters is the rate.
   */
  observeLuminance(luminance: number): void
  /** The multiplier every effect must apply to its output. 1 when nothing is flashing. */
  readonly intensity: number
  /** Back to rest: no envelope, no flash history, full intensity. */
  reset(): void
}

interface MutableFrame {
  waveform: WaveformBuffer
  spectrum: Float32Array
  bass: number
  mid: number
  treble: number
  level: number
  onset: number
  silent: boolean
  timeSec: number
}

function clampDt(dtSec: number): number {
  if (!(dtSec > 0)) return 0
  return dtSec > MAX_FRAME_DT_SEC ? MAX_FRAME_DT_SEC : dtSec
}

/** Rise at most `maxRise` towards `input`; fall to it at once. */
function limitRise(current: number, input: number, maxRise: number): number {
  if (input <= current) return input
  const next = current + maxRise
  return next < input ? next : input
}

export function createFlashGuard(): FlashGuard {
  const spectrum = new Float32Array(ANALYSIS_BANDS)
  const frame: MutableFrame = {
    waveform: new Float32Array(0),
    spectrum,
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    onset: 0,
    silent: true,
    timeSec: 0
  }

  // The onset envelope: rises (rate-limited) to `onsetPeak`, holds, then
  // `onsetPeak` decays and the envelope follows it down.
  let onsetPeak = 0

  /** The guard's own clock, in clamped seconds. */
  let nowSec = 0
  let intensity = 1
  let lastCutSec = Number.NEGATIVE_INFINITY

  // Two counters over the same samples. `flashes` counts swings that are
  // flashes now, and cuts intensity. `persisting` scales its threshold by
  // intensity — would this swing flash at full intensity? — and only holds the
  // cut, so recovery waits for the passage to end rather than climbing back
  // into a strobe that the cut itself made too small to see.
  const flashes = createTransitionCounter()
  const persisting = createTransitionCounter()

  function cut(swing: number): void {
    // The window holds three flashes' worth. The transition just counted is
    // already under way, so the cut has to land now, and deep enough that the
    // swing after it falls under the detect threshold.
    const target = (DAMP_HEADROOM * FLASH_DETECT_DELTA) / Math.max(swing, FLASH_DETECT_DELTA)
    const factor = target < DAMP_MAX_FACTOR ? target : DAMP_MAX_FACTOR
    intensity = Math.max(MIN_INTENSITY, intensity * factor)
    lastCutSec = nowSec
  }

  return {
    shape(audio, dtSec) {
      const dt = clampDt(dtSec)
      nowSec += dt
      const rise = Math.min(dt / MIN_ATTACK_SEC, MAX_RISE_PER_FRAME)

      for (let i = 0; i < ANALYSIS_BANDS; i++) {
        spectrum[i] = limitRise(spectrum[i], audio.spectrum[i] ?? 0, rise)
      }
      frame.bass = limitRise(frame.bass, audio.bass, rise)
      frame.mid = limitRise(frame.mid, audio.mid, rise)
      frame.treble = limitRise(frame.treble, audio.treble, rise)
      frame.level = limitRise(frame.level, audio.level, rise)

      if (audio.onset > onsetPeak) onsetPeak = audio.onset
      if (frame.onset < onsetPeak) {
        frame.onset = Math.min(onsetPeak, frame.onset + rise)
      } else {
        onsetPeak *= Math.exp(-dt / ONSET_RELEASE_SEC)
        frame.onset = onsetPeak
      }

      frame.waveform = audio.waveform
      frame.silent = audio.silent
      frame.timeSec = audio.timeSec

      if (intensity < 1 && nowSec - lastCutSec >= RECOVERY_HOLD_SEC) {
        intensity = Math.min(1, intensity + RECOVERY_PER_SEC * dt)
      }
      return frame
    },

    observeLuminance(luminance) {
      if (!Number.isFinite(luminance)) return
      const y = luminance < 0 ? 0 : luminance > 1 ? 1 : luminance
      const limit = MAX_FLASHES_PER_SEC * 2
      const swing = flashes.observe(y, FLASH_DETECT_DELTA, nowSec)
      if (swing > 0 && flashes.count >= limit) cut(swing)
      const scaled = Math.max(FLASH_DETECT_DELTA * intensity, PERSIST_FLOOR)
      if (persisting.observe(y, scaled, nowSec) > 0 && persisting.count >= limit) {
        lastCutSec = nowSec
      }
    },

    get intensity() {
      return intensity
    },

    reset() {
      spectrum.fill(0)
      frame.bass = 0
      frame.mid = 0
      frame.treble = 0
      frame.level = 0
      frame.onset = 0
      frame.silent = true
      frame.timeSec = 0
      onsetPeak = 0
      nowSec = 0
      intensity = 1
      lastCutSec = Number.NEGATIVE_INFINITY
      flashes.reset()
      persisting.reset()
    }
  }
}
