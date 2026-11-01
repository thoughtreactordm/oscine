import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import { createFlashGuard, MAX_RISE_PER_FRAME } from '../../../src/renderer/visualizer/flashGuard'
import {
  bandHeight,
  createRainfallModel,
  DROP_AMPLITUDE,
  DROP_SIGMA_MAX,
  DROP_SIGMA_MIN,
  DROP_V_HIGH,
  DROP_V_JITTER,
  DROP_V_LOW,
  dominantBand,
  MAX_STEPS,
  RAINFALL_OPACITY,
  RIPPLE_TAU_SEC,
  SIM_MAX_COLS,
  SIM_ROWS,
  simSize,
  STEP_SEC,
  stepDamping,
  WAVE_C2
} from '../../../src/renderer/visualizer/effects/rainfallModel'

/**
 * W23-11: Rainfall's model. The shaders can't be unit-tested, so the card's
 * properties are checked on the pure half. At emergence 0 it is the wash. The
 * surface is stepped on a fixed clock, so its damping is `dtSec`-correct. A
 * CPU mirror of the step shader shows a ring dies out over about 2 s and never
 * grows. Drops are placed by their band and arrive no faster than the guard's
 * envelope.
 */

function frame(overrides: Partial<Record<keyof AnalysisFrame, unknown>> = {}): AnalysisFrame {
  return {
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(ANALYSIS_BANDS).fill(0.3),
    bass: 0.5,
    mid: 0.5,
    treble: 0.5,
    level: 0.5,
    onset: 0,
    silent: false,
    timeSec: 0,
    ...overrides
  } as AnalysisFrame
}

const WASH_OPACITY = 0.198

/** The step shader on the CPU: clamped neighbours, leapfrog, multiplicative damping, drop on top. */
function createSurface(cols: number, rows: number) {
  let h = new Float32Array(cols * rows)
  let prev = new Float32Array(cols * rows)
  let next = new Float32Array(cols * rows)
  const held = new Float32Array(cols * rows)
  const at = (a: Float32Array, x: number, y: number) =>
    a[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))]
  return {
    get h() {
      return h
    },
    step(damp: number, drop?: { u: number; v: number; amplitude: number; sigma: number }) {
      const aspect = cols / rows
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const c = h[y * cols + x]
          const l = at(h, x + 1, y) + at(h, x - 1, y) + at(h, x, y + 1) + at(h, x, y - 1) - 4 * c
          let bump = 0
          if (drop && drop.amplitude !== 0) {
            const dx = ((x + 0.5) / cols - drop.u) * aspect
            const dy = (y + 0.5) / rows - drop.v
            bump = drop.amplitude * Math.exp(-(dx * dx + dy * dy) / (drop.sigma * drop.sigma))
          }
          next[y * cols + x] = (2 * c - prev[y * cols + x] + WAVE_C2 * l) * damp + bump
          // The shader writes s.r + drop into G: the bump lands on the old height too.
          held[y * cols + x] = c + bump
        }
      }
      h.set(held)
      const spare = prev
      prev = h
      h = next
      next = spare
    }
  }
}

function peak(a: Float32Array): number {
  let max = 0
  for (const v of a) max = Math.max(max, Math.abs(v))
  return max
}

describe('Rainfall at emergence 0', () => {
  it('injects, refracts, lights and layers exactly nothing however loud the music', () => {
    const model = createRainfallModel()
    const guard = createFlashGuard()
    for (let i = 0; i < 240; i++) {
      const loud = guard.shape(
        frame({ bass: 1, mid: 1, treble: 1, level: 1, onset: i % 6 === 0 ? 1 : 0 }),
        1 / 60
      )
      model.advance(1 / 60)
      const p = model.update(loud, 0, 1, WASH_OPACITY, 1 / 60)
      expect(p.detail).toBe(0)
      expect(p.refract).toBe(0)
      expect(p.highlight).toBe(0)
      expect(p.highlightMax).toBe(0)
      expect(model.drop.amplitude).toBe(0)
      expect(p.opacity).toBeCloseTo(WASH_OPACITY, 12)
    }
  })

  it('scales every term up from zero with emergence', () => {
    const at = (e: number) => {
      const model = createRainfallModel()
      model.update(frame({ onset: 0.5 }), e, 1, WASH_OPACITY, 1 / 60)
      return { ...model.params, drop: model.drop.amplitude }
    }
    const half = at(0.5)
    const full = at(1)
    expect(half.refract).toBeCloseTo(full.refract / 2, 12)
    expect(half.highlightMax).toBeCloseTo(full.highlightMax / 2, 12)
    expect(half.drop).toBeCloseTo(full.drop / 2, 12)
    expect(full.opacity).toBeCloseTo(RAINFALL_OPACITY, 12)
  })

  it('presents by the flash guard intensity', () => {
    const model = createRainfallModel()
    expect(model.update(frame(), 1, 0.3, WASH_OPACITY, 1 / 60).present).toBeCloseTo(0.3, 12)
    expect(model.update(frame(), 1, 0, WASH_OPACITY, 1 / 60).present).toBe(0)
  })
})

describe('Rainfall surface clock', () => {
  it('runs the same number of fixed steps over two seconds at any frame rate', () => {
    for (const fps of [24, 30, 60, 75, 144, 240]) {
      const model = createRainfallModel()
      let steps = 0
      for (let i = 0; i < fps * 2; i++) steps += model.advance(1 / fps)
      expect(Math.abs(steps - 2 / STEP_SEC)).toBeLessThanOrEqual(1)
    }
  })

  it('runs no more than the cap on a stalled frame and does not catch up afterwards', () => {
    const model = createRainfallModel()
    expect(model.advance(0.1)).toBe(MAX_STEPS)
    expect(model.advance(1 / 60)).toBeLessThanOrEqual(Math.ceil(1 / 60 / STEP_SEC))
  })

  it('damps a mode to exp(-t/τ) of its amplitude, however the steps are spread', () => {
    // The leapfrog's roots multiply to damp, so each step scales a mode by √damp.
    const damp = stepDamping()
    const steps = Math.round(2 / STEP_SEC)
    expect(Math.sqrt(damp) ** steps).toBeCloseTo(Math.exp(-2 / RIPPLE_TAU_SEC), 9)
  })
})

describe('Rainfall ripples (CPU mirror of the step shader)', () => {
  // A smaller grid than the GPU's keeps the test quick; the rates are per cell and per step.
  const cols = 96
  const rows = 64

  it('dies out over about two seconds and never grows', () => {
    const surface = createSurface(cols, rows)
    const damp = stepDamping()
    surface.step(damp, { u: 0.5, v: 0.5, amplitude: 1, sigma: 0.08 })
    const start = peak(surface.h)
    let previousPeak = Infinity
    let max = 0
    const steps = Math.round(2 / STEP_SEC)
    for (let i = 0; i < steps; i++) {
      surface.step(damp)
      const p = peak(surface.h)
      max = Math.max(max, p)
      if (i % 30 === 29) {
        // Sampled every 0.2 s: the envelope only falls.
        expect(p).toBeLessThan(previousPeak * 1.05)
        previousPeak = p
      }
    }
    expect(max).toBeLessThanOrEqual(start * 1.001)
    expect(peak(surface.h)).toBeLessThan(start * 0.05)
  })

  it('a drop becomes a ring that travels outward', () => {
    const surface = createSurface(cols, rows)
    const damp = stepDamping()
    surface.step(damp, { u: 0.5, v: 0.5, amplitude: 1, sigma: 0.05 })
    for (let i = 0; i < Math.round(0.3 / STEP_SEC); i++) surface.step(damp)
    // The crest has left the centre: the strongest cell sits away from it.
    let best = 0
    let bestR = 0
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = Math.abs(surface.h[y * cols + x])
        if (v > best) {
          best = v
          bestR = Math.hypot(x + 0.5 - cols / 2, y + 0.5 - rows / 2) / rows
        }
      }
    }
    expect(bestR).toBeGreaterThan(0.06)
  })
})

describe('Rainfall drops', () => {
  it('rise no faster than the flash guard lets an onset rise', () => {
    const model = createRainfallModel()
    const guard = createFlashGuard()
    let total = 0
    for (let i = 0; i < 30; i++) {
      const shaped = guard.shape(frame({ onset: i === 0 ? 1 : 0 }), 1 / 60)
      model.advance(1 / 60)
      model.update(shaped, 1, 1, WASH_OPACITY, 1 / 60)
      // Each frame adds at most one frame's rise of the envelope.
      expect(model.drop.amplitude).toBeLessThanOrEqual(DROP_AMPLITUDE * MAX_RISE_PER_FRAME + 1e-9)
      total += model.drop.amplitude
      model.consumeDrop()
    }
    // …and the whole onset arrives.
    expect(total).toBeCloseTo(DROP_AMPLITUDE, 6)
  })

  it('carry over a frame that runs no step', () => {
    const model = createRainfallModel()
    model.update(frame({ onset: 0.2 }), 1, 1, WASH_OPACITY, 1 / 240)
    model.update(frame({ onset: 0.4 }), 1, 1, WASH_OPACITY, 1 / 240)
    expect(model.drop.amplitude).toBeCloseTo(0.4 * DROP_AMPLITUDE, 9)
    model.consumeDrop()
    expect(model.drop.amplitude).toBe(0)
  })

  it('grow wider with a stronger onset', () => {
    const weak = createRainfallModel()
    weak.update(frame({ onset: 0.1 }), 1, 1, WASH_OPACITY, 1 / 60)
    const strong = createRainfallModel()
    strong.update(frame({ onset: 1 }), 1, 1, WASH_OPACITY, 1 / 60)
    expect(weak.drop.sigma).toBeLessThan(strong.drop.sigma)
    expect(strong.drop.sigma).toBeCloseTo(DROP_SIGMA_MAX, 12)
    expect(weak.drop.sigma).toBeGreaterThanOrEqual(DROP_SIGMA_MIN)
  })

  it('land low for a low band and high for a high one', () => {
    for (const [band, low, high] of [
      [2, 0, 0.35],
      [60, 0.65, 1]
    ] as const) {
      for (let seed = 1; seed < 40; seed++) {
        const model = createRainfallModel(seed)
        const spectrum = new Float32Array(ANALYSIS_BANDS).fill(0.3)
        model.update(frame({ spectrum }), 1, 1, WASH_OPACITY, 1 / 60)
        const lifted = new Float32Array(spectrum)
        lifted[band] = 1
        model.update(frame({ spectrum: lifted, onset: 1 }), 1, 1, WASH_OPACITY, 1 / 60)
        expect(model.drop.v).toBeGreaterThanOrEqual(low)
        expect(model.drop.v).toBeLessThanOrEqual(high)
        expect(Math.abs(model.drop.v - bandHeight(band, ANALYSIS_BANDS))).toBeLessThanOrEqual(
          DROP_V_JITTER + 1e-9
        )
      }
    }
  })

  it('start a new drop only when the envelope starts rising again', () => {
    const model = createRainfallModel()
    model.update(frame({ onset: 0.3 }), 1, 1, WASH_OPACITY, 1 / 60)
    const first = { u: model.drop.u, v: model.drop.v }
    model.update(frame({ onset: 0.6 }), 1, 1, WASH_OPACITY, 1 / 60)
    expect(model.drop.u).toBe(first.u)
    expect(model.drop.v).toBe(first.v)
    model.update(frame({ onset: 0.5 }), 1, 1, WASH_OPACITY, 1 / 60)
    model.update(frame({ onset: 0.9 }), 1, 1, WASH_OPACITY, 1 / 60)
    expect(model.drop.u === first.u && model.drop.v === first.v).toBe(false)
  })
})

describe('Rainfall helpers', () => {
  it('places the band ends at the band range', () => {
    expect(bandHeight(0, ANALYSIS_BANDS)).toBeCloseTo(DROP_V_LOW, 12)
    expect(bandHeight(ANALYSIS_BANDS - 1, ANALYSIS_BANDS)).toBeCloseTo(DROP_V_HIGH, 12)
  })

  it('picks the band that rose most, else the loudest', () => {
    const before = new Float32Array([0.5, 0.2, 0.9, 0.1])
    expect(dominantBand(new Float32Array([0.6, 0.7, 0.9, 0.1]), before)).toBe(1)
    expect(dominantBand(new Float32Array([0.4, 0.1, 0.8, 0.0]), before)).toBe(2)
    expect(dominantBand(new Float32Array(4), new Float32Array(4))).toBe(-1)
  })

  it('sizes the grid by aspect, in fixed rows', () => {
    expect(simSize(16 / 9)).toEqual({ cols: Math.round((SIM_ROWS * 16) / 9), rows: SIM_ROWS })
    expect(simSize(100).cols).toBe(SIM_MAX_COLS)
    expect(simSize(Number.NaN)).toEqual({ cols: SIM_ROWS, rows: SIM_ROWS })
  })

  it('keeps the wave inside the stability limit', () => {
    expect(WAVE_C2).toBeLessThanOrEqual(0.5)
  })
})
