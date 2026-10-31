import { MAX_FRAME_DT_SEC } from './analysisFrame'

/**
 * The host's emergence follower — **W23-4, D35.12** (the overlay half).
 *
 * `StageInputs.emergence` runs from 0 (the wash) to 1 (the effect). Playing
 * grows it in; pausing holds it for {@link PAUSE_HOLD_SEC} — the analysis decays
 * on its own meanwhile, so a short pause reads as the music stopping, not the
 * picture switching off — and then eases it back to the wash so the loop can
 * stop. A paused stage then looks like, and costs what, the ordinary stage does.
 *
 * The ease is a smoothstep over a linear progress, so it starts and ends gently
 * and the duration is exact rather than asymptotic: "settled" is a fact, not a
 * threshold, and the loop's stop condition depends on it.
 *
 * Pure and DOM-free.
 */

/** How long a full 0 → 1 (or 1 → 0) takes. */
export const EMERGENCE_SEC = 1.2
/** How long a pause holds the effect before it settles into the wash. */
export const PAUSE_HOLD_SEC = 3

export interface Emergence {
  /** 0..1, eased. */
  readonly value: number
  /** At the wash with nothing pulling it back up — the loop may stop. */
  readonly atRest: boolean
  /** Advance one rendered frame. */
  update(playing: boolean, dtSec: number): number
  /** Straight back to the wash. */
  reset(): void
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

export function createEmergence({
  durationSec = EMERGENCE_SEC,
  pauseHoldSec = PAUSE_HOLD_SEC
}: { durationSec?: number; pauseHoldSec?: number } = {}): Emergence {
  let progress = 0
  let pausedSec = 0

  const state = {
    value: 0,
    atRest: true,
    update(playing: boolean, dtSec: number): number {
      const dt = dtSec > 0 ? (dtSec > MAX_FRAME_DT_SEC ? MAX_FRAME_DT_SEC : dtSec) : 0
      const step = durationSec > 0 ? dt / durationSec : 1
      if (playing) {
        pausedSec = 0
        progress = progress + step > 1 ? 1 : progress + step
      } else {
        // Until the hold runs out a pause leaves the emergence wherever it is.
        pausedSec += dt
        if (pausedSec >= pauseHoldSec) progress = progress - step < 0 ? 0 : progress - step
      }
      state.value = smoothstep(progress)
      state.atRest = !playing && progress === 0
      return state.value
    },
    reset(): void {
      progress = 0
      pausedSec = 0
      state.value = 0
      state.atRest = true
    }
  }
  return state
}
