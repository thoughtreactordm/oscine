import { describe, expect, it } from 'vitest'
import type { Quality2D } from '../../../src/renderer/visualizer/effects/draw2d'
import { StrokeColour } from '../../../src/renderer/visualizer/effects/strokes'
import {
  createUpdraftModel,
  flowVelocity,
  HIGHLIGHT_EVERY,
  SEGMENT_FLOATS,
  TRAIL,
  type UpdraftModel
} from '../../../src/renderer/visualizer/effects/updraftModel'
import { DTS, makeFrame, section } from './strokeModelHarness'

/**
 * W23-16: Updraft's air and motes without the GPU. Segments are
 * `(x0, y0, x1, y1)`, `(width, alpha, colour, 0)`, pixels, y down.
 */

function seg(model: UpdraftModel, segment: number, offset: number): number {
  return model.instances[segment * SEGMENT_FLOATS + offset]
}

function drive(
  model: UpdraftModel,
  seconds: number,
  { intensity = 1, mixedRates = false, loud = true } = {}
): void {
  const frame = makeFrame()
  let time = 0
  for (let n = 0; time < seconds; n++) {
    const dt = mixedRates ? DTS[n % DTS.length] : 1 / 60
    time += dt
    section(frame, time, dt, loud)
    model.update(frame, intensity, dt)
  }
}

describe('the Updraft model', () => {
  it('blows a divergence-free wind', () => {
    const out = new Float64Array(2)
    const h = 1e-4
    for (const [x, y, t] of [
      [0.1, 0.2, 0],
      [-0.4, 0.3, 5],
      [0.7, -0.6, 12.5]
    ]) {
      flowVelocity(x + h, y, t, out)
      const right = out[0]
      flowVelocity(x - h, y, t, out)
      const left = out[0]
      flowVelocity(x, y + h, t, out)
      const up = out[1]
      flowVelocity(x, y - h, t, out)
      const down = out[1]
      expect((right - left + up - down) / (2 * h)).toBeCloseTo(0, 6)
    }
  })

  it('keeps every mote on the stage, reborn when it drifts off, across a resize', () => {
    const model = createUpdraftModel('high')
    model.resize(1280, 720)
    drive(model, 6, { mixedRates: true })
    model.resize(800, 1200)
    drive(model, 6, { mixedRates: true })
    // Motes may overshoot by the margin (0.08 of the shorter side) before rebirth.
    const slack = 0.1 * 800
    // The newest age is the last 1/TRAIL of segments; their far ends are the motes.
    const newest = model.count - model.motes
    for (let i = newest; i < model.count; i++) {
      expect(seg(model, i, 2)).toBeGreaterThan(-slack)
      expect(seg(model, i, 2)).toBeLessThan(800 + slack)
      expect(seg(model, i, 3)).toBeGreaterThan(-slack)
      expect(seg(model, i, 3)).toBeLessThan(1200 + slack)
    }
  })

  it('writes one finite segment per mote per age, at every quality and frame rate', () => {
    for (const quality of ['low', 'auto', 'high'] as Quality2D[]) {
      const model = createUpdraftModel(quality)
      model.resize(1920, 1080)
      drive(model, 8, { mixedRates: true })
      expect(model.count).toBe(model.motes * TRAIL)
      expect(model.count).toBeLessThanOrEqual(model.maxSegments)
      for (let i = 0; i < model.count; i++) {
        for (let f = 0; f < SEGMENT_FLOATS; f++) {
          expect(Number.isFinite(seg(model, i, f))).toBe(true)
        }
        expect(seg(model, i, 4)).toBeGreaterThanOrEqual(1)
        expect(seg(model, i, 5)).toBeGreaterThanOrEqual(0)
        expect(seg(model, i, 5)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('fades the trails in from the tail to the mote', () => {
    const model = createUpdraftModel('auto')
    model.resize(1920, 1080)
    drive(model, 3)
    const oldest = seg(model, 0, 5)
    const newest = seg(model, model.count - 1, 5)
    expect(newest).toBeGreaterThan(oldest * 4)
  })

  it('draws one mote in three in the highlight colour, after the others of its age', () => {
    const model = createUpdraftModel('auto')
    model.resize(1920, 1080)
    drive(model, 1)
    const perAge = model.motes
    const highlighted = Math.ceil(model.motes / HIGHLIGHT_EVERY)
    for (let i = 0; i < perAge; i++) {
      const expected = i < perAge - highlighted ? StrokeColour.accent : StrokeColour.highlighted
      expect(seg(model, i, 6)).toBe(expected)
    }
  })

  it("multiplies every segment's alpha by the flash guard's intensity", () => {
    const full = createUpdraftModel('auto')
    const damped = createUpdraftModel('auto')
    full.resize(1920, 1080)
    damped.resize(1920, 1080)
    drive(full, 3, { intensity: 1 })
    drive(damped, 3, { intensity: 0.5 })
    for (let i = 0; i < full.count; i += 97) {
      expect(seg(damped, i, 5)).toBeCloseTo(seg(full, i, 5) * 0.5, 6)
    }
  })

  it('keeps time but draws nothing before it has a size', () => {
    const model = createUpdraftModel('auto')
    drive(model, 1)
    expect(model.count).toBe(0)
  })
})
