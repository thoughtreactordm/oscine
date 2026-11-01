import { MAX_FRAME_DT_SEC } from './analysisFrame'

/**
 * The stage's transition model — **W23-5, D35.12** (and D35.7's pause).
 *
 * Every transition passes through the wash. This is the state machine that
 * makes that true, kept pure so each row of D35.12's table is a test rather
 * than a thing to eyeball in the dev build. The host (`VisualizerStage.vue`)
 * feeds it one update per rendered frame and does what it says; `StageView`
 * mirrors the two flags it raises.
 *
 * It tracks two quantities:
 *
 * - **handoff**, 0..1 — who owns the wash. 0 is the CSS `<img>`, 1 is the
 *   host's canvas. It moves linearly over one motion duration, the same 150 ms
 *   linear opacity transition `StageView` runs on the `<img>`, so the two can be
 *   cross-faded without the stacked pair ever reading heavier than one wash
 *   (`handoffOpacity` in `wash.ts`).
 * - **emergence**, 0..1 — the wash (0) to the effect (1). It is a smoothstep over
 *   a linear progress, so it starts and ends gently and "settled" is exact
 *   rather than a threshold the loop's stop condition would have to guess.
 *
 * ## The sequence
 *
 * - **On.** The host draws the wash for the current cover; once that frame has
 *   been on screen for a frame (`washReady` on two consecutive updates — the
 *   `requestAnimationFrame` after the first draw), `cssWashHidden` rises:
 *   `StageView` fades the `<img>` out while the handoff ramps to 1 and the
 *   emergence grows.
 * - **Off.** The emergence eases to 0; only then does `cssWashHidden` fall, the
 *   handoff ramps back to 0 under the `<img>`'s fade-in, and `retired` tells the
 *   stage it can unmount the host.
 * - **Pause.** The emergence holds for {@link PAUSE_HOLD_SEC} — the analysis
 *   decays meanwhile, so a short pause reads as the music stopping — then eases
 *   to 0 and `atRest` lets the loop stop on the wash. The layout never moves.
 * - **Switch.** The emergence eases to 0 over the shorter switch duration,
 *   `swapDue` is raised for exactly one update, and it grows back.
 *
 * All durations are multiples of `--oscine-motion-duration` (the host reads it);
 * the pause hold is a fixed 3 s, because it measures how long silence must last
 * to count as stopped, not how fast anything moves.
 *
 * Pure and DOM-free.
 */

/**
 * Emergence 0 ↔ 1: 0.6 s at the default 150 ms motion duration. Shorter than
 * D35.12's ~1.2 s by the operator's call (2026-10-31): the longer ease read as
 * sluggish on a stage that is otherwise quick.
 */
export const EMERGENCE_MOTION_MULTIPLE = 4
/** An effect switch's fall to the wash: 0.3 s at the default. */
export const SWITCH_MOTION_MULTIPLE = 2
/** The CSS ↔ canvas wash handoff: 150 ms at the default. */
export const HANDOFF_MOTION_MULTIPLE = 1
/** How long a pause holds the effect before it settles into the wash. */
export const PAUSE_HOLD_SEC = 3
/** The motion token's shipped default, for before the host has read it. */
export const DEFAULT_MOTION_SEC = 0.15

export interface TransitionDurations {
  readonly emergenceSec: number
  readonly switchSec: number
  readonly handoffSec: number
  readonly pauseHoldSec: number
}

/** D35.12's durations for a given `--oscine-motion-duration`, in seconds. */
export function transitionDurations(motionSec: number): TransitionDurations {
  const motion = Number.isFinite(motionSec) && motionSec > 0 ? motionSec : 0
  return {
    emergenceSec: motion * EMERGENCE_MOTION_MULTIPLE,
    switchSec: motion * SWITCH_MOTION_MULTIPLE,
    handoffSec: motion * HANDOFF_MOTION_MULTIPLE,
    pauseHoldSec: PAUSE_HOLD_SEC
  }
}

/**
 * `VITE_VISUALIZER_HOLD_EMERGENCE`, parsed: a number in 0..1, or null when the
 * flag is unset or not a number. Out-of-range values clamp.
 */
export function parseHoldEmergence(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export interface TransitionInputs {
  /** The stage wants the visualizer showing (`StageView`'s gate). False means leave. */
  readonly active: boolean
  /** Playback is playing. */
  readonly playing: boolean
  /**
   * The canvas wash is drawn for the current cover (or there is no cover to
   * draw). The handoff waits for this on two consecutive updates.
   */
  readonly washReady: boolean
}

export interface StageTransition {
  /** 0 = the wash, 1 = the effect; eased. What `StageInputs.emergence` carries. */
  readonly emergence: number
  /** 0 = the CSS wash owns the stage, 1 = the canvas does. Linear. */
  readonly handoff: number
  /** `StageView` fades its `<img>` out while this is true and back in when it falls. */
  readonly cssWashHidden: boolean
  /** True for exactly the one update at which the host should swap effects. */
  readonly swapDue: boolean
  /** Off, at the wash and handed back: the stage may unmount the host. */
  readonly retired: boolean
  /** Nothing is moving and nothing is owed; the loop may stop (D35.7). */
  readonly atRest: boolean
  /** The effect changed: settle to the wash, swap there, grow back. */
  requestSwitch(): void
  setDurations(durations: TransitionDurations): void
  /** Advance one rendered frame. */
  update(inputs: TransitionInputs, dtSec: number): void
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/** The progress whose smoothstep is `value`, so a held emergence is exactly the flag's value. */
function inverseSmoothstep(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return 0.5 - Math.sin(Math.asin(1 - 2 * value) / 3)
}

/** Move `value` toward `target` by at most `step`, landing on it exactly. */
function approach(value: number, target: number, step: number): number {
  if (value < target) return value + step >= target ? target : value + step
  if (value > target) return value - step <= target ? target : value - step
  return value
}

/** `dt / duration` as a step, where a zero duration means "at once". */
function rate(dt: number, durationSec: number): number {
  return durationSec > 0 ? dt / durationSec : Infinity
}

export function createStageTransition({
  durations = transitionDurations(DEFAULT_MOTION_SEC),
  holdEmergence = null
}: { durations?: TransitionDurations; holdEmergence?: number | null } = {}): StageTransition {
  let timing = durations
  /** The held emergence as a progress, or null when the dev flag is off. */
  const holdProgress = holdEmergence === null ? null : inverseSmoothstep(holdEmergence)
  let progress = 0
  let pausedSec = 0
  let switchPending = false
  let readyLastUpdate = false
  let playing = false
  let active = false

  const state = {
    emergence: 0,
    handoff: 0,
    cssWashHidden: false,
    swapDue: false,
    retired: false,
    atRest: false,

    requestSwitch(): void {
      switchPending = true
      state.atRest = false
    },

    setDurations(next: TransitionDurations): void {
      timing = next
    },

    update(inputs: TransitionInputs, dtSec: number): void {
      const dt = dtSec > 0 ? (dtSec > MAX_FRAME_DT_SEC ? MAX_FRAME_DT_SEC : dtSec) : 0
      active = inputs.active
      playing = inputs.playing
      state.swapDue = false

      // The `<img>`'s transition starts in the frame the flag changes, so the
      // canvas's ramp starts with it, not one step ahead of it.
      let turned = false
      if (active) {
        state.retired = false
        if (!state.cssWashHidden) {
          // Re-entered mid hand-back: the canvas still holds a drawn wash, so it
          // takes the stage straight back. Otherwise wait until the wash has been
          // on screen for a frame before the `<img>` is allowed to go.
          if (state.handoff > 0 || (inputs.washReady && readyLastUpdate)) {
            state.cssWashHidden = true
            turned = true
          }
        }
        readyLastUpdate = inputs.washReady

        if (!state.cssWashHidden) {
          // Nothing is showing yet, so a switch has nothing to settle: swap now.
          if (switchPending) {
            switchPending = false
            state.swapDue = true
          }
        } else {
          if (!turned) state.handoff = approach(state.handoff, 1, rate(dt, timing.handoffSec))
          if (switchPending) {
            progress = approach(progress, 0, rate(dt, timing.switchSec))
            if (progress === 0) {
              switchPending = false
              state.swapDue = true
            }
          } else if (holdProgress !== null) {
            // The dev flag freezes the emergence, playing or not.
            progress = approach(progress, holdProgress, rate(dt, timing.emergenceSec))
          } else if (playing) {
            pausedSec = 0
            progress = approach(progress, 1, rate(dt, timing.emergenceSec))
          } else {
            // Until the hold runs out a pause leaves the emergence where it is.
            pausedSec += dt
            if (pausedSec >= timing.pauseHoldSec) {
              progress = approach(progress, 0, rate(dt, timing.emergenceSec))
            }
          }
        }
      } else {
        readyLastUpdate = false
        progress = approach(progress, 0, rate(dt, timing.emergenceSec))
        if (progress === 0) {
          // At the wash: a switch requested on the way out lands here, so the
          // next time the visualizer comes on it is the new effect that grows.
          if (switchPending) {
            switchPending = false
            state.swapDue = true
          }
          turned = state.cssWashHidden
          state.cssWashHidden = false
          if (!turned) state.handoff = approach(state.handoff, 0, rate(dt, timing.handoffSec))
          if (state.handoff === 0) state.retired = true
        }
      }

      state.emergence = smoothstep(progress)
      state.atRest = state.retired || settledWhileActive()
    }
  }

  function settledWhileActive(): boolean {
    if (!active || !state.cssWashHidden || state.handoff !== 1 || switchPending) return false
    if (holdProgress !== null) return progress === holdProgress && !playing
    return progress === 0 && !playing
  }

  return state
}
