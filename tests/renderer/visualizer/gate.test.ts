import { describe, expect, it } from 'vitest'
import {
  resolveEffect,
  visualizerLoopRuns,
  visualizerToggle,
  visualizerWanted,
  type VisualizerLoopInputs,
  type VisualizerWantInputs
} from '../../../src/renderer/visualizer/gate'

/**
 * W23-4: the gating predicate (D35.5 × D35.7) as a truth table. Every
 * combination is enumerated rather than sampled, so a change to either
 * predicate shows up as the exact rows it moved.
 */

const BOOLS = [false, true] as const

function* wantRows(): Generator<VisualizerWantInputs> {
  for (const stageSetting of BOOLS)
    for (const inZenSetting of BOOLS)
      for (const zenActive of BOOLS)
        for (const zenOverride of [null, false, true] as const)
          yield { stageSetting, inZenSetting, zenActive, zenOverride }
}

function* loopRows(): Generator<VisualizerLoopInputs> {
  for (const enabled of BOOLS)
    for (const mounted of BOOLS)
      for (const hidden of BOOLS)
        for (const reducedMotion of BOOLS)
          for (const playing of BOOLS)
            for (const decaying of BOOLS)
              yield { enabled, mounted, hidden, reducedMotion, playing, decaying }
}

describe('visualizerWanted — the stage toggle under Zen’s override', () => {
  it('follows the stage setting alone outside Zen, whatever the Zen inputs say', () => {
    for (const row of wantRows()) {
      if (row.zenActive) continue
      expect(visualizerWanted(row)).toBe(row.stageSetting)
    }
  })

  it('shows in Zen when visualizerInZen is on, or the stage setting already is', () => {
    for (const row of wantRows()) {
      if (!row.zenActive || row.zenOverride !== null) continue
      expect(visualizerWanted(row)).toBe(row.inZenSetting || row.stageSetting)
    }
  })

  it('lets a toggle made inside Zen win for the rest of the Zen session', () => {
    for (const row of wantRows()) {
      if (!row.zenActive || row.zenOverride === null) continue
      expect(visualizerWanted(row)).toBe(row.zenOverride)
    }
  })

  it('matches the full table', () => {
    // [stage, inZen, zen, override] → wanted
    const table: Array<[boolean, boolean, boolean, boolean | null, boolean]> = [
      [false, false, false, null, false],
      [true, false, false, null, true],
      [false, true, false, null, false],
      [true, true, false, true, true],
      [false, false, true, null, false],
      [false, true, true, null, true],
      [true, false, true, null, true],
      [false, true, true, false, false],
      [true, false, true, false, false],
      [false, false, true, true, true]
    ]
    for (const [stageSetting, inZenSetting, zenActive, zenOverride, wanted] of table) {
      expect(visualizerWanted({ stageSetting, inZenSetting, zenActive, zenOverride })).toBe(wanted)
    }
  })
})

describe('visualizerToggle — Zen never writes the stage toggle', () => {
  it('writes the durable setting outside Zen and a session override inside it', () => {
    for (const row of wantRows()) {
      const action = visualizerToggle(row)
      expect(action.kind).toBe(row.zenActive ? 'session' : 'setting')
      expect(action.value).toBe(!visualizerWanted(row))
    }
  })

  it('turns the visualizer off in Zen when visualizerInZen put it on', () => {
    const inZen = { stageSetting: false, inZenSetting: true, zenActive: true, zenOverride: null }
    expect(visualizerToggle(inZen)).toEqual({ kind: 'session', value: false })
    expect(visualizerWanted({ ...inZen, zenOverride: false })).toBe(false)
  })
})

describe('visualizerLoopRuns — D35.7', () => {
  it('runs exactly when enabled, mounted, visible, motion allowed, and playing or decaying', () => {
    let running = 0
    for (const row of loopRows()) {
      const expected =
        row.enabled &&
        row.mounted &&
        !row.hidden &&
        !row.reducedMotion &&
        (row.playing || row.decaying)
      expect(visualizerLoopRuns(row), JSON.stringify(row)).toBe(expected)
      if (expected) running++
    }
    // Of 64 rows, three (playing, decaying, both) run.
    expect(running).toBe(3)
  })

  it('stops when hidden, under reduced motion, and once paused and settled', () => {
    const base: VisualizerLoopInputs = {
      enabled: true,
      mounted: true,
      hidden: false,
      reducedMotion: false,
      playing: true,
      decaying: false
    }
    expect(visualizerLoopRuns(base)).toBe(true)
    expect(visualizerLoopRuns({ ...base, hidden: true })).toBe(false)
    expect(visualizerLoopRuns({ ...base, reducedMotion: true })).toBe(false)
    expect(visualizerLoopRuns({ ...base, playing: false, decaying: true })).toBe(true)
    expect(visualizerLoopRuns({ ...base, playing: false, decaying: false })).toBe(false)
    expect(visualizerLoopRuns({ ...base, mounted: false })).toBe(false)
  })
})

describe('resolveEffect — an unknown id falls back at runtime', () => {
  const effects = [{ id: 'bars' }, { id: 'trace' }]

  it('finds the stored effect when it is available', () => {
    expect(resolveEffect(effects, 'trace')).toBe(effects[1])
  })

  it('falls back to the first available effect without touching the id', () => {
    const stored = 'drift'
    expect(resolveEffect(effects, stored)).toBe(effects[0])
    expect(stored).toBe('drift')
  })

  it('is null only with nothing available', () => {
    expect(resolveEffect([], 'bars')).toBeNull()
  })
})
