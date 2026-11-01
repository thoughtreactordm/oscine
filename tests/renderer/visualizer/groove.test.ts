import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import {
  createGrooveModel,
  GROOVE_OPACITY,
  lightBand,
  OMEGA_BASE,
  OMEGA_BASS,
  SMEAR_FLOOR,
  SMEAR_IDLE,
  SMEAR_LEVEL,
  smearAt
} from '../../../src/renderer/visualizer/effects/grooveModel'

/**
 * W23-11: Groove's model. At emergence 0 it is the wash. Smear length follows
 * level and angular velocity follows bass, frame-rate independently. The light
 * band is continuous and two-lobed.
 */

function frame(overrides: Partial<Record<keyof AnalysisFrame, unknown>> = {}): AnalysisFrame {
  return {
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(ANALYSIS_BANDS),
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
const TAU = Math.PI * 2

describe('Groove at emergence 0', () => {
  it('smears, lights and layers exactly nothing however loud the music', () => {
    const model = createGrooveModel()
    for (let i = 0; i < 120; i++) {
      const p = model.update(frame({ bass: 1, level: 1, onset: 1 }), 0, 1, WASH_OPACITY, 1 / 60)
      expect(p.smear).toBe(0)
      expect(p.sheen).toBe(0)
      expect(p.detail).toBe(0)
      expect(p.opacity).toBeCloseTo(WASH_OPACITY, 12)
    }
  })

  it('keeps turning, so the band does not jump when the effect returns', () => {
    const model = createGrooveModel()
    const before = model.update(frame(), 0, 1, WASH_OPACITY, 1 / 60).phase
    const after = model.update(frame(), 0, 1, WASH_OPACITY, 1 / 60).phase
    expect(after).not.toBe(before)
  })

  it('scales up from zero with emergence and presents by intensity', () => {
    const half = { ...createGrooveModel().update(frame(), 0.5, 0.4, WASH_OPACITY, 1 / 60) }
    const full = { ...createGrooveModel().update(frame(), 1, 0.4, WASH_OPACITY, 1 / 60) }
    expect(half.smear).toBeCloseTo(full.smear / 2, 12)
    expect(half.sheen).toBeCloseTo(full.sheen / 2, 12)
    expect(full.opacity).toBeCloseTo(GROOVE_OPACITY, 12)
    expect(full.present).toBeCloseTo(0.4, 12)
  })
})

describe('Groove motion', () => {
  it('smears longer as the level rises, within its range', () => {
    const smearAtLevel = (level: number) => {
      const model = createGrooveModel()
      let p = model.update(frame({ level }), 1, 1, WASH_OPACITY, 1 / 60)
      for (let i = 0; i < 60; i++) p = model.update(frame({ level }), 1, 1, WASH_OPACITY, 1 / 60)
      return p.smear
    }
    expect(smearAtLevel(0)).toBeCloseTo(SMEAR_IDLE, 9)
    expect(smearAtLevel(0.5)).toBeGreaterThan(smearAtLevel(0.2))
    expect(smearAtLevel(1)).toBeCloseTo(SMEAR_IDLE + SMEAR_LEVEL, 9)
  })

  it('turns faster with more bass, clockwise', () => {
    const quiet = createGrooveModel().update(frame({ bass: 0 }), 1, 1, WASH_OPACITY, 1 / 60)
    expect(quiet.omega).toBeCloseTo(OMEGA_BASE, 12)
    const loud = createGrooveModel().update(frame({ bass: 1 }), 1, 1, WASH_OPACITY, 1 / 60)
    expect(loud.omega).toBeCloseTo(OMEGA_BASE + OMEGA_BASS, 12)
    // Clockwise: the phase decreases (wrapped into [0, 2π)).
    expect(loud.phase).toBeCloseTo(TAU - (OMEGA_BASE + OMEGA_BASS) / 60, 9)
  })

  it('eases the speed into a kick rather than lurching', () => {
    const model = createGrooveModel()
    model.update(frame({ bass: 0 }), 1, 1, WASH_OPACITY, 1 / 60)
    const kicked = model.update(frame({ bass: 1 }), 1, 1, WASH_OPACITY, 1 / 60).omega
    expect(kicked).toBeLessThan(OMEGA_BASE + OMEGA_BASS * 0.1)
  })

  it('turns the same angle over two seconds at any frame rate', () => {
    const turned = (fps: number) => {
      const model = createGrooveModel()
      let unwrapped = 0
      let last = 0
      for (let i = 0; i < fps * 2; i++) {
        const bass = i / (fps * 2) < 0.5 ? 0.2 : 0.9
        const phase = model.update(frame({ bass }), 1, 1, WASH_OPACITY, 1 / fps).phase
        let d = phase - last
        if (d > Math.PI) d -= TAU
        if (d < -Math.PI) d += TAU
        unwrapped += d
        last = phase
      }
      return unwrapped
    }
    const reference = turned(240)
    for (const fps of [30, 60, 144]) expect(turned(fps)).toBeCloseTo(reference, 1)
  })
})

describe('Groove light band', () => {
  it('is two-lobed: full on the band, nothing across from it', () => {
    expect(lightBand(0.7, 0.7)).toBeCloseTo(1, 12)
    expect(lightBand(0.7 + Math.PI, 0.7)).toBeCloseTo(1, 12)
    expect(lightBand(0.7 + Math.PI / 2, 0.7)).toBeCloseTo(0, 12)
  })

  it('is continuous all the way round, the ±π wrap included', () => {
    for (let a = -Math.PI; a < Math.PI; a += 0.001) {
      expect(Math.abs(lightBand(a + 0.001, 1.3) - lightBand(a, 1.3))).toBeLessThan(0.003)
    }
    expect(lightBand(-Math.PI, 0.4)).toBeCloseTo(lightBand(Math.PI, 0.4), 12)
  })

  it('smears a floor share off the band', () => {
    expect(smearAt(0.2 + Math.PI / 2, 1, 0.2)).toBeCloseTo(SMEAR_FLOOR, 12)
    expect(smearAt(0.2, 1, 0.2)).toBeCloseTo(1, 12)
  })
})
