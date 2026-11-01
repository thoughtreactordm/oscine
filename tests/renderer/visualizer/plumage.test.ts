import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import { coverUvTransform } from '../../../src/renderer/visualizer/coverFit'
import {
  createFlashGuard,
  MAX_RISE_PER_FRAME,
  MIN_ATTACK_SEC
} from '../../../src/renderer/visualizer/flashGuard'
import {
  BLUR_FRACTION,
  createPlumageModel,
  detailLodFloor,
  foldAngle,
  LOD_GROW,
  PLUMAGE_OPACITY,
  SEGMENT_EASE_SEC,
  SEGMENTS_MAX,
  SEGMENTS_MIN,
  SPLIT_MAX
} from '../../../src/renderer/visualizer/effects/plumageModel'

/**
 * W23-10: Plumage's model. The shader can't be unit-tested, so the card's
 * properties are checked on the pure half: it is the wash at emergence 0, the
 * chromatic split never attacks faster than the flash guard allows, the
 * kaleidoscope's counts are integers eased without a seam, and the cover is
 * never sampled sharp.
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

const calm = { pulse: 0, heat: 0 }
const WASH_OPACITY = 0.198

describe('Plumage at emergence 0', () => {
  it('adds exactly nothing to the wash however loud the music', () => {
    const model = createPlumageModel()
    const loud = frame({ bass: 1, mid: 1, treble: 1, level: 1, onset: 1 })
    for (let i = 0; i < 120; i++) {
      const p = model.update(loud, { pulse: 1, heat: 1 }, 0, 1, WASH_OPACITY, 1 / 60)
      expect(p.detail).toBe(0)
      expect(p.kaleido).toBe(0)
      expect(p.displaceLow).toBe(0)
      expect(p.displaceMid).toBe(0)
      expect(p.displaceHigh).toBe(0)
      expect(p.split).toBe(0)
      expect(p.opacity).toBeCloseTo(WASH_OPACITY, 12)
      expect(p.lodBias).toBe(LOD_GROW)
      expect(p.present).toBe(1)
    }
  })

  it('scales every term up from zero with emergence', () => {
    const at = (e: number) => {
      const model = createPlumageModel()
      return { ...model.update(frame(), calm, e, 1, WASH_OPACITY, 1 / 60) }
    }
    const low = at(0.1)
    const high = at(1)
    expect(low.detail).toBeGreaterThan(0)
    expect(low.kaleido).toBeLessThan(high.kaleido)
    expect(low.displaceLow).toBeLessThan(high.displaceLow)
    expect(low.lodBias).toBeGreaterThan(high.lodBias)
    expect(high.lodBias).toBe(0)
    expect(high.opacity).toBeCloseTo(PLUMAGE_OPACITY, 12)
  })

  it('presents over the wash by the flash guard intensity', () => {
    const model = createPlumageModel()
    expect(model.update(frame(), calm, 1, 0.3, WASH_OPACITY, 1 / 60).present).toBe(0.3)
    const silenced = model.update(frame({ onset: 1 }), calm, 1, 0, WASH_OPACITY, 1 / 60)
    expect(silenced.present).toBe(0)
    expect(silenced.split).toBe(0)
  })
})

describe('the chromatic split', () => {
  it('never rises faster than the guard minimum attack, at any frame rate', () => {
    for (const fps of [10, 30, 60, 144, 240]) {
      const model = createPlumageModel()
      const dt = 1 / fps
      let last = 0
      let reachedAt = -1
      for (let i = 0; i < fps; i++) {
        model.update(frame({ onset: 1 }), calm, 1, 1, WASH_OPACITY, dt)
        const rise = model.splitEnvelope - last
        expect(rise).toBeLessThanOrEqual(Math.min(dt / MIN_ATTACK_SEC, MAX_RISE_PER_FRAME) + 1e-9)
        if (reachedAt < 0 && model.splitEnvelope >= 1) reachedAt = (i + 1) * dt
        last = model.splitEnvelope
      }
      expect(reachedAt).toBeGreaterThanOrEqual(MIN_ATTACK_SEC - 1e-9)
    }
  })

  it('stays inside its bound on a strobe-heavy onset train shaped by the real guard', () => {
    const guard = createFlashGuard()
    const model = createPlumageModel()
    const dt = 1 / 60
    let peaks = 0
    let rising = false
    let last = 0
    // 8 Hz full-strength impulses for 10 s: the D35.8 test train.
    for (let i = 0; i < 600; i++) {
      const impulse = i % 8 === 0 ? 1 : 0
      const shaped = guard.shape(frame({ onset: impulse, level: 1, bass: 1 }), dt)
      const p = model.update(shaped, calm, 1, guard.intensity, WASH_OPACITY, dt)
      expect(p.split).toBeLessThanOrEqual(SPLIT_MAX)
      const rise = model.splitEnvelope - last
      expect(rise).toBeLessThanOrEqual(dt / MIN_ATTACK_SEC + 1e-9)
      if (rise > 0) rising = true
      else if (rising && rise < 0) {
        peaks++
        rising = false
      }
      last = model.splitEnvelope
    }
    // The split may follow the beat, but never faster than the train itself.
    expect(peaks).toBeLessThanOrEqual(80)
  })

  it('is a small fraction of the stage even at full scale', () => {
    // A brief fringe, not a double image: under 1 % of the height.
    expect(SPLIT_MAX).toBeLessThan(0.01)
  })
})

describe('the kaleidoscope', () => {
  it('holds integer counts in range and eases between them', () => {
    const model = createPlumageModel()
    const dt = 1 / 60
    let changes = 0
    let lastB = model.params.segmentsB
    let changeStartedAt = -1
    for (let i = 0; i < 60 * 120; i++) {
      // Level swinging between quiet and loud phrases every 8 s, with beat jitter.
      const phrase = Math.floor((i * dt) / 8) % 2 === 0 ? 0.15 : 0.95
      const level = phrase + (i % 15 < 7 ? 0.05 : -0.05)
      const p = model.update(frame({ level }), calm, 1, 1, WASH_OPACITY, dt)
      expect(Number.isInteger(p.segmentsA)).toBe(true)
      expect(Number.isInteger(p.segmentsB)).toBe(true)
      for (const n of [p.segmentsA, p.segmentsB]) {
        expect(n).toBeGreaterThanOrEqual(SEGMENTS_MIN)
        expect(n).toBeLessThanOrEqual(SEGMENTS_MAX)
      }
      expect(p.segmentBlend).toBeGreaterThanOrEqual(0)
      expect(p.segmentBlend).toBeLessThanOrEqual(1)
      if (p.segmentsB !== lastB) {
        // A new change only starts once the last has finished easing.
        if (changeStartedAt >= 0) {
          expect(i * dt - changeStartedAt).toBeGreaterThanOrEqual(SEGMENT_EASE_SEC - 2 * dt)
        }
        changeStartedAt = i * dt
        changes++
        lastB = p.segmentsB
      }
    }
    expect(changes).toBeGreaterThan(0)
    // Counts hold for phrases, not beats: 15 phrase changes, a handful of steps each at most.
    expect(changes).toBeLessThan(15 * 6)
  })

  it('folds seamlessly for every integer count, the ±π wrap included', () => {
    for (let n = SEGMENTS_MIN; n <= SEGMENTS_MAX; n++) {
      for (const rotation of [0, 0.7, 2.9]) {
        const steps = 20000
        let previous = foldAngle(-Math.PI, n, rotation)
        for (let i = 1; i <= steps; i++) {
          const angle = -Math.PI + (2 * Math.PI * i) / steps
          const value = foldAngle(angle, n, rotation)
          expect(Math.abs(value - previous)).toBeLessThan(1e-3)
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(Math.PI / n + 1e-12)
          previous = value
        }
      }
    }
  })

  it('rotates and drifts frame-rate independently', () => {
    const run = (fps: number) => {
      const model = createPlumageModel()
      for (let i = 0; i < fps * 10; i++) model.update(frame(), calm, 1, 1, WASH_OPACITY, 1 / fps)
      return { ...model.params }
    }
    const slow = run(30)
    const fast = run(144)
    expect(fast.rotation).toBeCloseTo(slow.rotation, 2)
    expect(fast.lowPhase).toBeCloseTo(slow.lowPhase, 3)
    expect(fast.highPhase).toBeCloseTo(slow.highPhase, 2)
  })
})

describe('the cover layer', () => {
  it('is never sampled finer than the blur floor', () => {
    const uv = new Float32Array(4)
    for (const [coverAspect, boxAspect] of [
      [1, 16 / 9],
      [1, 9 / 16],
      [1.5, 1],
      [1, 32 / 9]
    ]) {
      coverUvTransform(coverAspect, boxAspect, 1.25, uv)
      for (const height of [640, 256]) {
        const visible = height * Math.abs(uv[1])
        const lod = detailLodFloor(height, uv[1])
        // One texel at that mip spans at least BLUR_FRACTION of what is on screen…
        if (visible * BLUR_FRACTION > 1) {
          expect(2 ** lod / visible).toBeCloseTo(BLUR_FRACTION, 9)
        } else {
          // …or the cover is so small that its own texels are already that coarse.
          expect(lod).toBe(0)
        }
      }
    }
  })

  it('puts a square 640-px cover on a 16:9 stage at least two mips down', () => {
    // 45 % of its height shows (the crop and the wash's 1.25 zoom), ~288 texels.
    const uv = coverUvTransform(1, 16 / 9, 1.25)
    expect(detailLodFloor(640, uv[1])).toBeGreaterThan(2)
  })
})
