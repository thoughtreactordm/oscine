import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS } from '../../../src/renderer/visualizer/analysisFrame'
import type { Quality2D } from '../../../src/renderer/visualizer/effects/draw2d'
import {
  CAPACITY,
  createWhorlModel,
  INSTANCE_FLOATS,
  MAX_INSTANCES,
  WhorlColour,
  type WhorlModel
} from '../../../src/renderer/visualizer/effects/whorlModel'

/**
 * W23-16: Whorl's tunnel without the GPU. The renderer trusts these records
 * as they are — rows in range, widths and alphas finite and sane — so this is
 * where that is checked.
 */

interface MutableFrame {
  waveform: Float32Array<ArrayBuffer>
  spectrum: Float32Array
  bass: number
  mid: number
  treble: number
  level: number
  onset: number
  silent: boolean
  timeSec: number
}

function makeFrame(): MutableFrame {
  return {
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(ANALYSIS_BANDS),
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    onset: 0,
    silent: true,
    timeSec: 0
  }
}

/** A lively frame (as `effects2d.test.ts` drives the 2D effects), loud or quiet. */
function section(frame: MutableFrame, timeSec: number, dtSec: number, loud: boolean): void {
  frame.timeSec = timeSec
  const beat = 0.5 + 0.5 * Math.sin(timeSec * Math.PI * 4)
  const gain = loud ? 1 : 0.2
  for (let index = 0; index < frame.waveform.length; index++) {
    frame.waveform[index] =
      gain * 0.6 * beat * Math.sin((index / 1024) * Math.PI * 2 * 9 + timeSec * 7)
  }
  for (let band = 0; band < ANALYSIS_BANDS; band++) {
    frame.spectrum[band] = Math.max(
      0,
      beat * (1 - band / ANALYSIS_BANDS) + 0.1 * Math.sin(band + timeSec * 5)
    )
  }
  frame.bass = beat
  frame.mid = beat * 0.6
  frame.treble = beat * 0.3
  frame.level = loud ? 0.85 : 0.2
  frame.onset = loud && timeSec % 0.25 < dtSec ? 1 : 0
  frame.silent = false
}

/** 144 Hz, 60 Hz, a capped rate, and the 0.1 s clamp. */
const DTS = [1 / 144, 1 / 60, 1 / 30, 0.1]

function run(
  model: WhorlModel,
  seconds: number,
  { loud = true, dt = 1 / 60, intensity = 1, width = 1920, height = 1080 } = {}
): void {
  const frame = makeFrame()
  let time = 0
  for (let n = 0; n < Math.round(seconds / dt); n++) {
    time += dt
    section(frame, time, dt, loud)
    model.update(frame, intensity, width, height, dt)
  }
}

function field(model: WhorlModel, instance: number, offset: number): number {
  return model.instances[instance * INSTANCE_FLOATS + offset]
}

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
      const model = createWhorlModel(quality)
      const frame = makeFrame()
      let time = 0
      for (let n = 0; n < 900; n++) {
        const dt = DTS[n % DTS.length]
        time += dt
        section(frame, time, dt, n % 300 < 200)
        model.update(frame, 1, 1920, 1080, dt)
        expect(model.count).toBeLessThanOrEqual(MAX_INSTANCES)
        for (let i = 0; i < model.count; i++) {
          for (let f = 0; f < INSTANCE_FLOATS; f++) {
            expect(Number.isFinite(field(model, i, f))).toBe(true)
          }
          const row = field(model, i, 3)
          expect(Number.isInteger(row) && row >= 0 && row < model.rows).toBe(true)
          expect(field(model, i, 4)).toBeGreaterThanOrEqual(1)
          expect(field(model, i, 5)).toBeGreaterThanOrEqual(0)
          expect(field(model, i, 5)).toBeLessThanOrEqual(1)
        }
      }
      for (const value of model.shapes) expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('draws the live ring last, as a band and then a bright core', () => {
    const model = createWhorlModel('auto')
    run(model, 2)
    const band = model.count - 2
    const core = model.count - 1
    expect(field(model, band, 3)).toBe(CAPACITY)
    expect(field(model, core, 3)).toBe(CAPACITY)
    expect(field(model, band, 6)).toBe(WhorlColour.accent)
    expect(field(model, core, 6)).toBe(WhorlColour.highlighted)
    expect(field(model, core, 4)).toBeLessThan(field(model, band, 4))
  })

  it('marks rings laid on a beat in the highlight colour', () => {
    const model = createWhorlModel('auto')
    run(model, 4, { loud: true })
    const tunnel = Array.from({ length: model.count - 2 }, (_, i) => field(model, i, 6))
    expect(tunnel).toContain(WhorlColour.highlighted)
    expect(tunnel).toContain(WhorlColour.accent)
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
