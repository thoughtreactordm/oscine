import type { VisualizerQuality } from '@shared/settings'

/**
 * The WebGL tier's resolution budget and `interface.visualizerQuality` —
 * **W23-8, D35.6 / R16**.
 *
 * WebGL effects render to an internal target capped in pixels and the
 * compositor scales it up to the canvas box, so Zen on a 4K panel costs what
 * 1080p costs (and the softness suits feedback effects):
 *
 * | quality | cap | frame rate |
 * |---|---|---|
 * | `auto` | ~2.1 MP (1920×1080) | 60 fps, backing off to `low` |
 * | `low` | 1 MP | 30 fps |
 * | `high` | native | 60 fps |
 *
 * `auto`'s backoff watches a rolling frame-time average. Once it has stayed
 * over budget for {@link BACKOFF_SEC} the governor switches to `low`'s profile
 * and stays there until something resets it (a new effect, a quality change):
 * at 30 fps the frame interval no longer says anything about headroom, so
 * there is no honest signal to climb back on.
 *
 * The hysteresis is on the timer: the average must rise above
 * {@link OVER_BUDGET_FACTOR} × the budget to count, and only falling below
 * {@link UNDER_BUDGET_FACTOR} × resets the count; in between it holds. One
 * sample is clamped to {@link MAX_SAMPLE_MS}, so a decode or GC hitch nudges the
 * average instead of spending most of the two seconds by itself.
 *
 * Pure and DOM-free.
 */

/** `auto`'s cap: 1920×1080. */
export const AUTO_CAP_PIXELS = 1920 * 1080
/** `low`'s cap. */
export const LOW_CAP_PIXELS = 1_000_000
/** `low`'s frame interval, the ribbon's `FRAME_MS`: 30 fps. */
export const LOW_FRAME_MS = 33
/** The frame time `auto` and `high` aim at. */
export const TARGET_FRAME_MS = 1000 / 60
/** The average must exceed this × the target to count as over budget (~46 fps). */
export const OVER_BUDGET_FACTOR = 1.3
/** …and fall below this × the target (~52 fps) to reset the count. */
export const UNDER_BUDGET_FACTOR = 1.15
/** How long the average must stay over budget before `auto` backs off. */
export const BACKOFF_SEC = 2
/** The rolling average's time constant. */
export const AVERAGE_TIME_CONSTANT_SEC = 0.5
/** One frame-time sample counts for at most this much. */
export const MAX_SAMPLE_MS = 50

export interface RenderProfile {
  /** The internal target's pixel cap; `Infinity` for native. */
  readonly capPixels: number
  /** The minimum interval between rendered frames; 0 for every display frame. */
  readonly minFrameMs: number
}

const AUTO_PROFILE: RenderProfile = { capPixels: AUTO_CAP_PIXELS, minFrameMs: 0 }
const LOW_PROFILE: RenderProfile = { capPixels: LOW_CAP_PIXELS, minFrameMs: LOW_FRAME_MS }
const HIGH_PROFILE: RenderProfile = { capPixels: Infinity, minFrameMs: 0 }

/** The profile for a quality setting, with `auto`'s backoff applied. */
export function renderProfile(quality: VisualizerQuality, backedOff = false): RenderProfile {
  if (quality === 'low') return LOW_PROFILE
  if (quality === 'high') return HIGH_PROFILE
  return backedOff ? LOW_PROFILE : AUTO_PROFILE
}

export interface Size {
  readonly width: number
  readonly height: number
}

/**
 * The internal target for a canvas of `width`×`height` backing pixels under a
 * pixel cap: the same aspect, scaled down uniformly until it fits, never up.
 */
export function internalSize(width: number, height: number, capPixels: number): Size {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const pixels = w * h
  if (!(capPixels > 0) || pixels <= capPixels) return { width: w, height: h }
  const scale = Math.sqrt(capPixels / pixels)
  // Floor, so the rounded size never lands a pixel over the cap.
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) }
}

export interface QualityGovernor {
  readonly quality: VisualizerQuality
  /** `auto` has backed off to `low`'s profile. */
  readonly backedOff: boolean
  readonly profile: RenderProfile
  /** The rolling average frame time, ms; 0 before the first sample. */
  readonly averageMs: number
  setQuality(quality: VisualizerQuality): void
  /** Forget the history and any backoff: a new effect, or the loop restarting. */
  reset(): void
  /**
   * One rendered frame took `frameMs` since the last. Returns true when this
   * sample made `auto` back off, i.e. the profile just changed.
   */
  observe(frameMs: number): boolean
}

export function createQualityGovernor(initial: VisualizerQuality = 'auto'): QualityGovernor {
  let quality = initial
  let backedOff = false
  let averageMs = 0
  let overSec = 0

  function clearHistory(): void {
    averageMs = 0
    overSec = 0
  }

  return {
    get quality() {
      return quality
    },
    get backedOff() {
      return backedOff
    },
    get profile() {
      return renderProfile(quality, backedOff)
    },
    get averageMs() {
      return averageMs
    },
    setQuality(next) {
      if (next === quality) return
      quality = next
      backedOff = false
      clearHistory()
    },
    reset() {
      backedOff = false
      clearHistory()
    },
    observe(frameMs) {
      if (quality !== 'auto' || backedOff) return false
      if (!(frameMs > 0)) return false
      const sample = frameMs > MAX_SAMPLE_MS ? MAX_SAMPLE_MS : frameMs
      const sampleSec = sample / 1000
      if (averageMs === 0) {
        averageMs = sample
      } else {
        const weight = 1 - Math.exp(-sampleSec / AVERAGE_TIME_CONSTANT_SEC)
        averageMs += (sample - averageMs) * weight
      }
      if (averageMs > TARGET_FRAME_MS * OVER_BUDGET_FACTOR) {
        overSec += sampleSec
        if (overSec >= BACKOFF_SEC) {
          backedOff = true
          overSec = 0
          return true
        }
      } else if (averageMs < TARGET_FRAME_MS * UNDER_BUDGET_FACTOR) {
        overSec = 0
      }
      return false
    }
  }
}
