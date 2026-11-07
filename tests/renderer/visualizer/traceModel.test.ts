import { describe, expect, it } from 'vitest'
import type { Quality2D } from '../../../src/renderer/visualizer/effects/draw2d'
import { StrokeColour } from '../../../src/renderer/visualizer/effects/strokes'
import {
  CAPACITY,
  createTraceModel,
  MAX_INSTANCES
} from '../../../src/renderer/visualizer/effects/traceModel'
import { expectSaneStrokes, field, makeFrame, run, section } from './strokeModelHarness'

/**
 * W23-16: Trace's ribbon and afterimages without the GPU, in the `ribbon`
 * layout — `(centreY, tilt, amplitude, row)`, `(width, alpha, colour, shiftX)`.
 */

const AMPLITUDE = 2
const SHIFT = 7

describe('the Trace model', () => {
  it('draws a loud passage bigger than a quiet one', () => {
    function amplitude(loud: boolean): number {
      const model = createTraceModel('auto')
      const frame = makeFrame()
      let time = 0
      for (let n = 0; n < 120; n++) {
        time += 1 / 60
        section(frame, time, 1 / 60, loud)
        frame.onset = 0
        model.update(frame, 1, 1280, 720, 1 / 60)
      }
      // The live ribbon's band is the second-last stroke.
      return field(model, model.count - 2, AMPLITUDE)
    }
    expect(amplitude(true)).toBeGreaterThan(amplitude(false) * 2)
  })

  it('writes only finite, in-range strokes, at every quality and frame rate', () => {
    for (const quality of ['low', 'auto', 'high'] as Quality2D[]) {
      expectSaneStrokes(createTraceModel(quality), MAX_INSTANCES)
    }
  })

  it('draws the live ribbon last and unscrolled, as a band and then a bright core', () => {
    const model = createTraceModel('auto')
    run(model, 2)
    const band = model.count - 2
    const core = model.count - 1
    for (const stroke of [band, core]) {
      expect(field(model, stroke, 3)).toBe(CAPACITY)
      expect(field(model, stroke, SHIFT)).toBe(0)
    }
    expect(field(model, band, 6)).toBe(StrokeColour.accent)
    expect(field(model, core, 6)).toBe(StrokeColour.highlighted)
    expect(field(model, core, 4)).toBeLessThan(field(model, band, 4))
  })

  it('scrolls afterimages left, older ones further, and drops them once off the stage', () => {
    const width = 1920
    const model = createTraceModel('auto')
    run(model, 3, { width })
    const afterimages = model.count - 2
    expect(afterimages).toBeGreaterThan(5)
    // The oldest has drifted; the newest may have been laid this very frame.
    expect(field(model, 0, SHIFT)).toBeGreaterThan(0)
    let previous = Infinity
    for (let i = 0; i < afterimages; i++) {
      const shift = field(model, i, SHIFT)
      expect(shift).toBeGreaterThanOrEqual(0)
      expect(shift).toBeLessThanOrEqual(width)
      // Oldest first, so the shift only falls along the list.
      expect(shift).toBeLessThanOrEqual(previous)
      previous = shift
    }
  })

  it("multiplies every stroke's alpha by the flash guard's intensity", () => {
    const full = createTraceModel('auto')
    const damped = createTraceModel('auto')
    run(full, 3, { intensity: 1 })
    run(damped, 3, { intensity: 0.5 })
    expect(damped.count).toBe(full.count)
    for (let i = 0; i < full.count; i++) {
      expect(field(damped, i, 5)).toBeCloseTo(field(full, i, 5) * 0.5, 6)
    }
  })

  it('keeps time but draws nothing on an empty target', () => {
    const model = createTraceModel('auto')
    run(model, 1, { width: 0, height: 0 })
    expect(model.count).toBe(0)
  })
})
