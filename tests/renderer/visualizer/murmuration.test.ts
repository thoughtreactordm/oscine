import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import { createFlashGuard, MAX_RISE_PER_FRAME } from '../../../src/renderer/visualizer/flashGuard'
import {
  createMurmurationModel,
  FLOCK_RADIUS,
  FLOCK_STRETCH,
  flockShape,
  MAX_PARTICLES,
  MIN_PARTICLES,
  particleCount,
  SCATTER_TAU_SEC,
  scatterAngle,
  SPEED_MAX,
  SPEED_MIN,
  type FlockShape
} from '../../../src/renderer/visualizer/effects/murmurationModel'
import {
  AUTO_CAP_PIXELS,
  internalSize,
  LOW_CAP_PIXELS
} from '../../../src/renderer/visualizer/qualityBudget'

/**
 * W23-12: Murmuration's model. The particles live on the GPU, so the card's
 * properties are checked on the pure half. The flock thins with the quality
 * tier and stays on the stage. Bass sets the speed. Onsets scatter it from a
 * point placed by their band, and the scatter rises no faster than the flash
 * guard lets an onset rise. Everything is frame-rate independent.
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

/** A spectrum whose `band` has just jumped. */
function risingAt(band: number): Float32Array {
  const spectrum = new Float32Array(ANALYSIS_BANDS).fill(0.3)
  spectrum[band] = 1
  return spectrum
}

describe('particleCount', () => {
  it('scales with the internal target, so the tiers order low < auto < high', () => {
    const low = internalSize(3840, 2160, LOW_CAP_PIXELS)
    const auto = internalSize(3840, 2160, AUTO_CAP_PIXELS)
    const lowCount = particleCount(low.width, low.height)
    const autoCount = particleCount(auto.width, auto.height)
    const highCount = particleCount(3840, 2160)
    expect(lowCount).toBeLessThan(autoCount)
    expect(autoCount).toBeLessThan(highCount)
    expect(lowCount).toBeGreaterThanOrEqual(MIN_PARTICLES)
    expect(highCount).toBeLessThanOrEqual(MAX_PARTICLES)
  })

  it('is "a few thousand" everywhere, and bounded for tiny and huge targets', () => {
    expect(particleCount(0, 0)).toBe(MIN_PARTICLES)
    expect(particleCount(1, 1)).toBe(MIN_PARTICLES)
    expect(particleCount(7680, 4320)).toBe(MAX_PARTICLES)
    expect(particleCount(1920, 1080)).toBeGreaterThan(3000)
  })
})

describe('flockShape', () => {
  it('keeps the whole ellipse on the stage at any time and aspect', () => {
    const shape: FlockShape = { x: 0, y: 0, radiusX: 0, radiusY: 0, angle: 0 }
    const reach = FLOCK_RADIUS * (1 + FLOCK_STRETCH)
    for (const aspect of [0.75, 1, 16 / 9, 21 / 9, 32 / 9]) {
      for (let t = 0; t < 2000; t += 0.37) {
        flockShape(t, aspect, shape)
        expect(Math.abs(shape.x) + reach).toBeLessThanOrEqual(aspect / 2 + 1e-9)
        expect(Math.abs(shape.y) + reach).toBeLessThanOrEqual(0.5 + 1e-9)
        expect(Math.max(shape.radiusX, shape.radiusY)).toBeLessThanOrEqual(reach + 1e-9)
        expect(Math.min(shape.radiusX, shape.radiusY)).toBeGreaterThan(0)
      }
    }
  })

  it('moves slowly: never more than a few hundredths of the stage in a tenth of a second', () => {
    const a: FlockShape = { x: 0, y: 0, radiusX: 0, radiusY: 0, angle: 0 }
    const b: FlockShape = { ...a }
    for (let t = 0; t < 600; t += 1.3) {
      flockShape(t, 16 / 9, a)
      flockShape(t + 0.1, 16 / 9, b)
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(0.02)
    }
  })
})

describe('scatterAngle', () => {
  it('puts the lowest band straight down and the highest straight up, either side', () => {
    for (const side of [1, -1] as const) {
      expect(Math.sin(scatterAngle(0, ANALYSIS_BANDS, side))).toBeCloseTo(-1, 9)
      expect(Math.sin(scatterAngle(ANALYSIS_BANDS - 1, ANALYSIS_BANDS, side))).toBeCloseTo(1, 9)
    }
    const mid = ANALYSIS_BANDS / 2
    expect(Math.cos(scatterAngle(mid, ANALYSIS_BANDS, 1))).toBeGreaterThan(0)
    expect(Math.cos(scatterAngle(mid, ANALYSIS_BANDS, -1))).toBeLessThan(0)
  })
})

describe('createMurmurationModel', () => {
  it('sets the flow speed from the bass, smoothly', () => {
    const model = createMurmurationModel()
    for (let i = 0; i < 300; i++) model.update(frame({ bass: 0 }), 1, 16 / 9, 1 / 60)
    expect(model.params.speed).toBeCloseTo(SPEED_MIN, 6)
    const before = model.params.speed
    model.update(frame({ bass: 1 }), 1, 16 / 9, 1 / 60)
    // One frame of a kick moves the speed only part of the way.
    expect(model.params.speed - before).toBeLessThan(0.1 * (SPEED_MAX - SPEED_MIN))
    for (let i = 0; i < 300; i++) model.update(frame({ bass: 1 }), 1, 16 / 9, 1 / 60)
    expect(model.params.speed).toBeCloseTo(SPEED_MAX, 6)
  })

  it('runs the flock clock faster with more bass', () => {
    const quiet = createMurmurationModel()
    const loud = createMurmurationModel()
    for (let i = 0; i < 120; i++) {
      quiet.update(frame({ bass: 0 }), 1, 1, 1 / 60)
      loud.update(frame({ bass: 1 }), 1, 1, 1 / 60)
    }
    expect(loud.params.time).toBeGreaterThan(quiet.params.time)
  })

  it('decays the scatter at the same rate at 30 and 144 fps', () => {
    for (const fps of [30, 60, 144]) {
      const model = createMurmurationModel()
      model.update(frame({ onset: 1 }), 1, 1, 1 / fps)
      expect(model.params.scatter).toBe(1)
      for (let i = 0; i < fps; i++) model.update(frame(), 1, 1, 1 / fps)
      expect(model.params.scatter).toBeCloseTo(Math.exp(-1 / SCATTER_TAU_SEC), 6)
    }
  })

  it('rises no faster than the flash guard lets an onset rise (no strobe)', () => {
    const model = createMurmurationModel()
    const guard = createFlashGuard()
    let previous = 0
    let peak = 0
    for (let i = 0; i < 600; i++) {
      // Full-strength onsets at 6 Hz: the worst case for a strobe.
      const audio = guard.shape(frame({ onset: i % 10 === 0 ? 1 : 0 }), 1 / 60)
      model.update(audio, guard.intensity, 1, 1 / 60)
      expect(model.params.scatter - previous).toBeLessThanOrEqual(MAX_RISE_PER_FRAME + 1e-9)
      previous = model.params.scatter
      peak = Math.max(peak, previous)
    }
    expect(peak).toBeGreaterThan(0.5)
  })

  it('scatters from below the centre for a low band and above it for a high one', () => {
    for (const [band, below] of [
      [2, true],
      [ANALYSIS_BANDS - 3, false]
    ] as const) {
      const model = createMurmurationModel()
      model.update(frame(), 1, 16 / 9, 1 / 60)
      model.update(frame({ spectrum: risingAt(band), onset: 0.5 }), 1, 16 / 9, 1 / 60)
      const params = model.params
      expect(params.scatterY < params.y).toBe(below)
      const distance = Math.hypot(params.scatterX - params.x, params.scatterY - params.y)
      expect(distance).toBeGreaterThan(0)
      expect(distance).toBeLessThan(Math.max(params.radiusX, params.radiusY))
    }
  })

  it('keeps one scatter point per onset, riding with the flock, and picks a new one on the next', () => {
    const model = createMurmurationModel()
    model.update(frame(), 1, 1, 1 / 60)
    model.update(frame({ spectrum: risingAt(2), onset: 0.3 }), 1, 1, 1 / 60)
    const offset = () => [
      model.params.scatterX - model.params.x,
      model.params.scatterY - model.params.y
    ]
    const first = offset()
    // Still rising, now with a high band loudest: the point does not jump.
    model.update(frame({ spectrum: risingAt(60), onset: 0.6 }), 1, 1, 1 / 60)
    expect(offset()).toEqual(first)
    // The envelope falls, then a new onset rises in the highs.
    model.update(frame({ onset: 0.2 }), 1, 1, 1 / 60)
    model.update(frame({ spectrum: risingAt(60), onset: 0.7 }), 1, 1, 1 / 60)
    const second = offset()
    expect(second[1]).toBeGreaterThan(0)
    expect(second).not.toEqual(first)
  })

  it('shows the flock by the flash guard intensity', () => {
    const model = createMurmurationModel()
    expect(model.update(frame(), 0, 1, 1 / 60).present).toBe(0)
    expect(model.update(frame(), 0.4, 1, 1 / 60).present).toBe(0.4)
    expect(model.update(frame(), 2, 1, 1 / 60).present).toBe(1)
  })

  it('treats a zero or negative dt as no time passing', () => {
    const model = createMurmurationModel()
    model.update(frame({ onset: 1 }), 1, 1, 1 / 60)
    const time = model.params.time
    model.update(frame(), 1, 1, 0)
    model.update(frame(), 1, 1, -1)
    expect(model.params.time).toBe(time)
    expect(model.params.scatter).toBe(1)
  })
})
