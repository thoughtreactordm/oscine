import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import { BARS_KNOBS } from '../../../src/renderer/visualizer/effects/bars'
import { DRIFT_KNOBS } from '../../../src/renderer/visualizer/effects/driftModel'
import {
  createGrooveModel,
  GROOVE_KNOBS
} from '../../../src/renderer/visualizer/effects/grooveModel'
import { GYRE_KNOBS } from '../../../src/renderer/visualizer/effects/gyre'
import { HALO_KNOBS } from '../../../src/renderer/visualizer/effects/halo'
import {
  flockShape,
  MURMURATION_KNOBS,
  type FlockShape
} from '../../../src/renderer/visualizer/effects/murmurationModel'
import { PLUMAGE_KNOBS } from '../../../src/renderer/visualizer/effects/plumageModel'
import { RAINFALL_KNOBS } from '../../../src/renderer/visualizer/effects/rainfallModel'
import { SILK_KNOBS } from '../../../src/renderer/visualizer/effects/silk'
import { TRACE_KNOBS } from '../../../src/renderer/visualizer/effects/trace'
import { UPDRAFT_KNOBS } from '../../../src/renderer/visualizer/effects/updraft'
import { WHORL_KNOBS } from '../../../src/renderer/visualizer/effects/whorl'
import { resolveParams, writeParams } from '../../../src/renderer/visualizer/params'

/**
 * Every effect's knobs: well-formed specs whose defaults are the untuned look,
 * and read live — the host writes into the object the effect already holds.
 */

const ALL = {
  bars: BARS_KNOBS,
  halo: HALO_KNOBS,
  gyre: GYRE_KNOBS,
  trace: TRACE_KNOBS,
  whorl: WHORL_KNOBS,
  silk: SILK_KNOBS,
  updraft: UPDRAFT_KNOBS,
  drift: DRIFT_KNOBS,
  plumage: PLUMAGE_KNOBS,
  rainfall: RAINFALL_KNOBS,
  groove: GROOVE_KNOBS,
  murmuration: MURMURATION_KNOBS
}

describe('effect knob specs', () => {
  for (const [effect, specs] of Object.entries(ALL)) {
    it(`${effect}: a few knobs, unique ids, default 1 inside a real range`, () => {
      expect(specs.length).toBeGreaterThanOrEqual(3)
      expect(specs.length).toBeLessThanOrEqual(5)
      expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length)
      for (const spec of specs) {
        expect(spec.label.length).toBeGreaterThan(0)
        expect(spec.default).toBe(1)
        expect(spec.min).toBeLessThan(spec.max)
        expect(spec.min).toBeLessThanOrEqual(spec.default)
        expect(spec.max).toBeGreaterThanOrEqual(spec.default)
        expect(spec.step).toBeGreaterThan(0)
      }
    })
  }
})

function frame(): AnalysisFrame {
  return {
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(ANALYSIS_BANDS),
    bass: 0.5,
    mid: 0.5,
    treble: 0.5,
    level: 0.5,
    onset: 0,
    silent: false,
    timeSec: 0
  } as AnalysisFrame
}

describe('knobs are live', () => {
  it('a model reads a change written into its knobs object on the next update', () => {
    const knobs = resolveParams(GROOVE_KNOBS, undefined)
    const tuned = createGrooveModel(knobs)
    const untuned = createGrooveModel()
    const a = tuned.update(frame(), 1, 1, 0.2, 1 / 60)
    const b = untuned.update(frame(), 1, 1, 0.2, 1 / 60)
    expect(a.omega).toBe(b.omega)
    expect(a.smear).toBe(b.smear)

    writeParams(knobs, GROOVE_KNOBS, { spin: 0, smear: 2 })
    const after = tuned.update(frame(), 1, 1, 0.2, 1 / 60)
    expect(after.omega).toBe(0)
    expect(after.smear).toBeGreaterThan(b.smear)
  })
})

describe('flockShape tuning', () => {
  const shape = (): FlockShape => ({ x: 0, y: 0, radiusX: 0, radiusY: 0, angle: 0 })

  it('is the untuned shape at size 1, wander 1', () => {
    for (const t of [0, 3.7, 41, 260]) {
      const plain = flockShape(t, 16 / 9, shape())
      const tuned = flockShape(t, 16 / 9, shape(), 1, 1)
      expect(tuned).toEqual(plain)
    }
  })

  it('keeps a large, wandering flock inside the stage height', () => {
    for (let t = 0; t < 400; t += 1.3) {
      const out = flockShape(t, 16 / 9, shape(), 1.6, 2)
      expect(Math.abs(out.y) + Math.max(out.radiusX, out.radiusY)).toBeLessThanOrEqual(0.5 + 1e-9)
    }
  })
})
