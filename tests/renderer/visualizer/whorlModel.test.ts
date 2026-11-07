import { describe, expect, it } from 'vitest'
import type { Quality2D } from '../../../src/renderer/visualizer/effects/draw2d'
import { StrokeColour } from '../../../src/renderer/visualizer/effects/strokes'
import {
  CAPACITY,
  createWhorlModel,
  MAX_INSTANCES
} from '../../../src/renderer/visualizer/effects/whorlModel'
import { expectSaneStrokes, field, makeFrame, run, section } from './strokeModelHarness'

/**
 * W23-16: Whorl's tunnel without the GPU. The renderer trusts these records
 * as they are — rows in range, widths and alphas finite and sane — so this is
 * where that is checked.
 */

describe('the Whorl model', () => {
  it('builds a long tunnel as the song picks up', () => {
    const quiet = createWhorlModel('auto')
    const loud = createWhorlModel('auto')
    run(quiet, 6, { loud: false })
    run(loud, 6, { loud: true })
    expect(loud.count).toBeGreaterThan(quiet.count * 2.5)
    expect(loud.count).toBeGreaterThan(25)
  })

  it('writes only finite, in-range strokes, at every quality and frame rate', () => {
    for (const quality of ['low', 'auto', 'high'] as Quality2D[]) {
      expectSaneStrokes(createWhorlModel(quality), MAX_INSTANCES)
    }
  })

  it('draws the live ring last, as a band and then a bright core', () => {
    const model = createWhorlModel('auto')
    run(model, 2)
    const band = model.count - 2
    const core = model.count - 1
    expect(field(model, band, 3)).toBe(CAPACITY)
    expect(field(model, core, 3)).toBe(CAPACITY)
    expect(field(model, band, 6)).toBe(StrokeColour.accent)
    expect(field(model, core, 6)).toBe(StrokeColour.highlighted)
    expect(field(model, core, 4)).toBeLessThan(field(model, band, 4))
  })

  it('marks rings laid on a beat in the highlight colour', () => {
    const model = createWhorlModel('auto')
    run(model, 4, { loud: true })
    const tunnel = Array.from({ length: model.count - 2 }, (_, i) => field(model, i, 6))
    expect(tunnel).toContain(StrokeColour.highlighted)
    expect(tunnel).toContain(StrokeColour.accent)
  })

  it("multiplies every stroke's alpha by the flash guard's intensity", () => {
    const full = createWhorlModel('auto')
    const damped = createWhorlModel('auto')
    run(full, 3, { intensity: 1 })
    run(damped, 3, { intensity: 0.5 })
    expect(damped.count).toBe(full.count)
    for (let i = 0; i < full.count; i++) {
      expect(field(damped, i, 5)).toBeCloseTo(field(full, i, 5) * 0.5, 6)
    }
  })

  it('snapshots about fifteen rings a second, whatever the frame rate', () => {
    for (const dt of [1 / 144, 1 / 60, 1 / 30]) {
      const model = createWhorlModel('auto')
      const frame = makeFrame()
      let snapshots = 0
      let time = 0
      for (let n = 0; n < Math.round(2 / dt); n++) {
        time += dt
        section(frame, time, dt, true)
        model.update(frame, 1, 1920, 1080, dt)
        if (model.snapshotRow >= 0) snapshots++
      }
      expect(snapshots).toBeGreaterThanOrEqual(28)
      expect(snapshots).toBeLessThanOrEqual(31)
    }
  })

  it('keeps time but draws nothing on an empty target', () => {
    const model = createWhorlModel('auto')
    run(model, 1, { width: 0, height: 0 })
    expect(model.count).toBe(0)
  })
})
