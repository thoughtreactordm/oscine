import { describe, expect, it } from 'vitest'
import {
  createStageTransition,
  EMERGENCE_MOTION_MULTIPLE,
  HANDOFF_MOTION_MULTIPLE,
  parseHoldEmergence,
  PAUSE_HOLD_SEC,
  SWITCH_MOTION_MULTIPLE,
  transitionDurations,
  type StageTransition,
  type TransitionInputs
} from '../../../src/renderer/visualizer/stageTransition'

const DT = 1 / 60
const D = transitionDurations(0.15)
/** The largest per-frame emergence step: smoothstep's steepest slope is 1.5. */
const MAX_STEP = (1.5 * DT) / D.emergenceSec + 1e-9

const PLAYING: TransitionInputs = { active: true, playing: true, washReady: true }
const PAUSED: TransitionInputs = { active: true, playing: false, washReady: true }
const OFF_PLAYING: TransitionInputs = { active: false, playing: true, washReady: true }

/** Advance for `seconds`, returning every update's snapshot. */
function run(t: StageTransition, inputs: TransitionInputs, seconds: number) {
  const seen: { emergence: number; handoff: number; hidden: boolean; swap: boolean }[] = []
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += DT) {
    t.update(inputs, DT)
    seen.push({
      emergence: t.emergence,
      handoff: t.handoff,
      hidden: t.cssWashHidden,
      swap: t.swapDue
    })
  }
  return seen
}

/** Present the wash and grow to full. */
function shown(): StageTransition {
  const t = createStageTransition({ durations: D })
  run(t, PLAYING, D.emergenceSec + 0.1)
  expect(t.emergence).toBe(1)
  expect(t.handoff).toBe(1)
  return t
}

/** No step between two consecutive updates larger than a frame's worth of ease. */
function expectContinuous(values: number[], maxStep: number) {
  for (let i = 1; i < values.length; i++) {
    expect(Math.abs(values[i] - values[i - 1])).toBeLessThanOrEqual(maxStep)
  }
}

describe('transitionDurations', () => {
  it('derives every duration from the motion token, and holds the pause fixed', () => {
    expect(D.emergenceSec).toBeCloseTo(0.15 * EMERGENCE_MOTION_MULTIPLE)
    expect(D.emergenceSec).toBeCloseTo(0.6)
    expect(D.switchSec).toBeCloseTo(0.15 * SWITCH_MOTION_MULTIPLE)
    expect(D.handoffSec).toBeCloseTo(0.15 * HANDOFF_MOTION_MULTIPLE)
    expect(D.pauseHoldSec).toBe(PAUSE_HOLD_SEC)
    expect(transitionDurations(0.3).emergenceSec).toBeCloseTo(1.2)
    expect(transitionDurations(Number.NaN).emergenceSec).toBe(0)
  })
})

describe('parseHoldEmergence', () => {
  it('reads 0..1, clamps outside it, and ignores anything else', () => {
    expect(parseHoldEmergence('0')).toBe(0)
    expect(parseHoldEmergence('0.35')).toBe(0.35)
    expect(parseHoldEmergence('4')).toBe(1)
    expect(parseHoldEmergence('-1')).toBe(0)
    expect(parseHoldEmergence('')).toBeNull()
    expect(parseHoldEmergence('soon')).toBeNull()
    expect(parseHoldEmergence(undefined)).toBeNull()
  })
})

describe('createStageTransition — on', () => {
  it('starts with the CSS wash showing and nothing emerged', () => {
    const t = createStageTransition({ durations: D })
    expect(t.emergence).toBe(0)
    expect(t.handoff).toBe(0)
    expect(t.cssWashHidden).toBe(false)
    expect(t.retired).toBe(false)
  })

  it('waits for the wash to be drawn and on screen a frame before the <img> may go', () => {
    const t = createStageTransition({ durations: D })
    run(t, { ...PLAYING, washReady: false }, 0.5)
    expect(t.cssWashHidden).toBe(false)
    expect(t.emergence).toBe(0)
    expect(t.atRest).toBe(false)

    t.update(PLAYING, DT) // drawn this frame
    expect(t.cssWashHidden).toBe(false)
    t.update(PLAYING, DT) // …and presented by the next
    expect(t.cssWashHidden).toBe(true)
  })

  it('hands the wash over in one motion duration while the effect grows in', () => {
    const t = createStageTransition({ durations: D })
    const seen = run(t, PLAYING, D.emergenceSec + 0.1)
    const presented = seen.findIndex((s) => s.hidden)
    const handedAt = seen.findIndex((s) => s.handoff === 1)
    const grownAt = seen.findIndex((s) => s.emergence === 1)
    expect((handedAt - presented + 1) * DT).toBeCloseTo(D.handoffSec, 1)
    expect((grownAt - presented + 1) * DT).toBeCloseTo(D.emergenceSec, 1)
    expectContinuous(
      seen.map((s) => s.emergence),
      MAX_STEP
    )
  })
})

describe('createStageTransition — off', () => {
  it('settles to the wash before handing it back, then retires', () => {
    const t = shown()
    const seen = run(t, OFF_PLAYING, D.emergenceSec + D.handoffSec + 0.1)
    const backAt = seen.findIndex((s) => !s.hidden)
    // The <img> only comes back once the emergence is at the wash.
    expect(seen[backAt].emergence).toBe(0)
    for (const s of seen.slice(0, backAt)) expect(s.handoff).toBe(1)
    expect(t.handoff).toBe(0)
    expect(t.retired).toBe(true)
    expect(t.atRest).toBe(true)
    expectContinuous(
      seen.map((s) => s.emergence),
      MAX_STEP
    )
  })

  it('retires at once if it never took the wash', () => {
    const t = createStageTransition({ durations: D })
    t.update({ ...PLAYING, washReady: false }, DT)
    t.update({ ...OFF_PLAYING, washReady: false }, DT)
    expect(t.retired).toBe(true)
    expect(t.cssWashHidden).toBe(false)
  })

  it('off during on: turns back from wherever the emergence had reached, without a jump', () => {
    const t = createStageTransition({ durations: D })
    const growing = run(t, PLAYING, D.emergenceSec / 2)
    const reached = growing[growing.length - 1].emergence
    expect(reached).toBeGreaterThan(0.2)
    expect(reached).toBeLessThan(0.8)
    const leaving = run(t, OFF_PLAYING, D.emergenceSec + D.handoffSec)
    expect(Math.abs(leaving[0].emergence - reached)).toBeLessThan(MAX_STEP)
    expectContinuous(
      leaving.map((s) => s.emergence),
      MAX_STEP
    )
    expect(t.retired).toBe(true)
  })

  it('on during the hand-back: takes the wash straight back without waiting for a redraw', () => {
    const t = shown()
    run(t, OFF_PLAYING, D.emergenceSec + DT * 3)
    expect(t.cssWashHidden).toBe(false)
    expect(t.handoff).toBeGreaterThan(0)
    expect(t.retired).toBe(false)

    t.update({ ...PLAYING, washReady: false }, DT)
    expect(t.cssWashHidden).toBe(true)
    run(t, PLAYING, D.emergenceSec + 0.1)
    expect(t.handoff).toBe(1)
    expect(t.emergence).toBe(1)
  })

  it('on again after retiring: un-retires and presents afresh', () => {
    const t = shown()
    run(t, OFF_PLAYING, D.emergenceSec + D.handoffSec + 0.1)
    expect(t.retired).toBe(true)
    t.update(PLAYING, DT)
    expect(t.retired).toBe(false)
    expect(t.atRest).toBe(false)
    t.update(PLAYING, DT)
    expect(t.cssWashHidden).toBe(true)
  })
})

describe('createStageTransition — pause and resume', () => {
  it('holds for the pause hold, then settles to the wash and comes to rest there', () => {
    const t = shown()
    run(t, PAUSED, PAUSE_HOLD_SEC - 0.2)
    expect(t.emergence).toBe(1)
    expect(t.atRest).toBe(false)
    run(t, PAUSED, 0.2 + D.emergenceSec + 0.1)
    expect(t.emergence).toBe(0)
    expect(t.atRest).toBe(true)
    // Settling into the wash is not handing it back: the canvas keeps it.
    expect(t.cssWashHidden).toBe(true)
    expect(t.handoff).toBe(1)
    expect(t.retired).toBe(false)
  })

  it('does not grow while paused, even inside the hold', () => {
    const t = createStageTransition({ durations: D })
    run(t, PLAYING, D.emergenceSec / 3)
    const held = t.emergence
    run(t, PAUSED, 1)
    expect(t.emergence).toBe(held)
  })

  it('resume grows back out of the wash', () => {
    const t = shown()
    run(t, PAUSED, PAUSE_HOLD_SEC + D.emergenceSec + 0.1)
    expect(t.atRest).toBe(true)
    t.update(PLAYING, DT)
    expect(t.atRest).toBe(false)
    expect(t.emergence).toBeGreaterThan(0)
    run(t, PLAYING, D.emergenceSec)
    expect(t.emergence).toBe(1)
  })

  it('a short pause resets the hold, so the next one gets the full hold again', () => {
    const t = shown()
    run(t, PAUSED, PAUSE_HOLD_SEC - 0.5)
    run(t, PLAYING, 0.1)
    run(t, PAUSED, PAUSE_HOLD_SEC - 0.5)
    expect(t.emergence).toBe(1)
  })
})

describe('createStageTransition — effect switch', () => {
  it('settles over the switch duration, raises swapDue for exactly one update, and grows back', () => {
    const t = shown()
    t.requestSwitch()
    expect(t.atRest).toBe(false)
    const seen = run(t, PLAYING, D.switchSec + D.emergenceSec + 0.2)
    const swaps = seen.filter((s) => s.swap)
    expect(swaps).toHaveLength(1)
    const swapAt = seen.findIndex((s) => s.swap)
    expect(seen[swapAt].emergence).toBe(0)
    expect((swapAt + 1) * DT).toBeCloseTo(D.switchSec, 1)
    expect(t.emergence).toBe(1)
    // The wash never changes hands across a switch.
    for (const s of seen) expect(s.handoff).toBe(1)
  })

  it('pause → switch → resume: swaps at the settled wash, stays there paused, grows on resume', () => {
    const t = shown()
    run(t, PAUSED, PAUSE_HOLD_SEC + D.emergenceSec + 0.1)
    expect(t.atRest).toBe(true)

    t.requestSwitch()
    expect(t.atRest).toBe(false)
    t.update(PAUSED, DT)
    expect(t.swapDue).toBe(true)
    expect(t.emergence).toBe(0)
    t.update(PAUSED, DT)
    expect(t.swapDue).toBe(false)
    expect(t.emergence).toBe(0)
    expect(t.atRest).toBe(true)

    run(t, PLAYING, D.emergenceSec + 0.1)
    expect(t.emergence).toBe(1)
  })

  it('a switch inside the pause hold still settles first, then waits at the wash', () => {
    const t = shown()
    run(t, PAUSED, 1)
    t.requestSwitch()
    const seen = run(t, PAUSED, D.switchSec + 0.5)
    expect(seen.filter((s) => s.swap)).toHaveLength(1)
    expect(t.emergence).toBe(0)
  })

  it('swaps at once when nothing is showing yet', () => {
    const t = createStageTransition({ durations: D })
    t.requestSwitch()
    t.update({ ...PLAYING, washReady: false }, DT)
    expect(t.swapDue).toBe(true)
  })

  it('a switch on the way out lands at the wash, so the next on grows the new effect', () => {
    const t = shown()
    run(t, OFF_PLAYING, D.emergenceSec / 2)
    t.requestSwitch()
    const seen = run(t, OFF_PLAYING, D.emergenceSec + D.handoffSec)
    const swapAt = seen.findIndex((s) => s.swap)
    expect(swapAt).toBeGreaterThanOrEqual(0)
    expect(seen[swapAt].emergence).toBe(0)
    expect(t.retired).toBe(true)
  })
})

describe('createStageTransition — track change and no cover', () => {
  it('a cover decoding mid-show leaves the emergence and the wash alone', () => {
    const t = shown()
    const seen = run(t, { ...PLAYING, washReady: false }, 1)
    for (const s of seen) {
      expect(s.emergence).toBe(1)
      expect(s.hidden).toBe(true)
      expect(s.handoff).toBe(1)
    }
  })

  it('with no cover the wash is ready at once and the effect grows from the bare stage', () => {
    const t = createStageTransition({ durations: D })
    t.update(PLAYING, DT)
    t.update(PLAYING, DT)
    expect(t.cssWashHidden).toBe(true)
    expect(t.emergence).toBeGreaterThan(0)
  })
})

describe('createStageTransition — the handoff ramp', () => {
  it('starts on the frame after the <img> is told to go, not the frame it is told', () => {
    const t = createStageTransition({ durations: D })
    t.update(PLAYING, DT)
    t.update(PLAYING, DT)
    expect(t.cssWashHidden).toBe(true)
    expect(t.handoff).toBe(0)
    t.update(PLAYING, DT)
    expect(t.handoff).toBeGreaterThan(0)
  })

  it('and on the way back, starts on the frame after the <img> is told to return', () => {
    const t = shown()
    const seen = run(t, OFF_PLAYING, D.emergenceSec + D.handoffSec + 0.1)
    const backAt = seen.findIndex((s) => !s.hidden)
    expect(seen[backAt].handoff).toBe(1)
    expect(seen[backAt + 1].handoff).toBeLessThan(1)
  })
})

describe('createStageTransition — timing edges', () => {
  it('a zero motion duration makes every step immediate', () => {
    const t = createStageTransition({ durations: transitionDurations(0) })
    t.update(PLAYING, DT) // drawn
    t.update(PLAYING, DT) // presented: the <img> starts going
    expect(t.emergence).toBe(1)
    t.update(PLAYING, DT)
    expect(t.handoff).toBe(1)
    t.update(OFF_PLAYING, DT) // at the wash: the <img> starts coming back
    expect(t.cssWashHidden).toBe(false)
    t.update(OFF_PLAYING, DT)
    expect(t.retired).toBe(true)
  })

  it('clamps a stall to the frame cap rather than jumping', () => {
    const t = createStageTransition({ durations: D })
    t.update(PLAYING, DT)
    t.update(PLAYING, DT)
    t.update(PLAYING, 5)
    expect(t.emergence).toBeLessThan(0.1)
  })

  it('picks up new durations from the next update', () => {
    const t = createStageTransition({ durations: D })
    t.setDurations(transitionDurations(0.3))
    const seen = run(t, PLAYING, 3)
    const presented = seen.findIndex((s) => s.hidden)
    const grownAt = seen.findIndex((s) => s.emergence === 1)
    expect((grownAt - presented + 1) * DT).toBeCloseTo(1.2, 1)
  })
})

describe('createStageTransition — VITE_VISUALIZER_HOLD_EMERGENCE', () => {
  it('freezes the emergence at the held value, playing or paused', () => {
    const t = createStageTransition({ durations: D, holdEmergence: 0.35 })
    run(t, PLAYING, D.emergenceSec + 0.1)
    expect(t.emergence).toBeCloseTo(0.35, 10)
    run(t, PAUSED, PAUSE_HOLD_SEC + D.emergenceSec + 0.1)
    expect(t.emergence).toBeCloseTo(0.35, 10)
    expect(t.atRest).toBe(true)
  })

  it('holds at exactly 0 for the wash comparison', () => {
    const t = createStageTransition({ durations: D, holdEmergence: 0 })
    run(t, PLAYING, 2)
    expect(t.emergence).toBe(0)
    expect(t.handoff).toBe(1)
  })

  it('still settles and retires when turned off', () => {
    const t = createStageTransition({ durations: D, holdEmergence: 1 })
    run(t, PLAYING, D.emergenceSec + 0.1)
    run(t, OFF_PLAYING, D.emergenceSec + D.handoffSec + 0.1)
    expect(t.retired).toBe(true)
  })
})
