import { describe, expect, it } from 'vitest'
import { gammaEncode } from '@shared/theme'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import {
  createDriftModel,
  driftStep,
  ringMask,
  RING_WIDTH,
  RING_WIDTH_MIN_PX,
  type DriftParams
} from '../../../src/renderer/visualizer/effects/driftModel'
import {
  PALETTE_SLOT_COUNT,
  PaletteSlot,
  type Palette
} from '../../../src/renderer/visualizer/palette'

/**
 * W23-9: Drift's model. The shader can't be unit-tested (D35.12), so the
 * properties the card asks for are checked on the pure half: the field is the
 * wash at emergence 0, growth and motion are frame-rate independent, and the
 * recurrence the shader runs stays bounded and alive over 30 minutes.
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

const calmDrive = { pulse: 0, heat: 0 }

function palette(version = 1): Palette {
  const linear = new Float32Array(PALETTE_SLOT_COUNT * 3)
  for (let i = 0; i < linear.length; i++) linear[i] = (i % 7) / 7
  return { css: [], linear, oklab: new Float32Array(PALETTE_SLOT_COUNT * 3), version }
}

/** Run `seconds` at `fps` and return the product/compound of the per-frame params. */
function integrate(fps: number, seconds: number, emergence: number) {
  const model = createDriftModel()
  model.update(frame(), calmDrive, emergence, 1, 1 / fps) // spend the first-frame reseed
  let keep = 1
  let survive = 1
  let zoom = 1
  let spin = 0
  for (let i = 0; i < fps * seconds; i++) {
    const p = model.update(frame(), calmDrive, emergence, 1, 1 / fps)
    keep *= p.keep
    survive *= 1 - p.decay
    zoom *= p.zoom
    spin += p.spin
  }
  return { keep, survive, zoom, spin }
}

describe('Drift model', () => {
  it('is the wash exactly at emergence 0', () => {
    const model = createDriftModel()
    for (let i = 0; i < 10; i++) {
      const p = model.update(frame({ onset: 1, bass: 1 }), { pulse: 1, heat: 1 }, 0, 1, 1 / 60)
      expect(p.keep).toBe(0)
      expect(p.dither).toBe(0)
      expect(p.ringAlpha).toBe(0)
      expect(p.decay).toBe(0)
      expect(p.zoom).toBe(1)
      expect(p.spin).toBe(0)
      expect(p.turbulence).toBe(0)
      // With keep = 0 the recurrence returns the wash whatever the field held.
      expect(driftStep(0.9, 0.2, 0.05, 1, 1, p)).toBe(0.2)
    }
  })

  it('re-seeds from the wash on the first frame and after reseed()', () => {
    const model = createDriftModel()
    expect(model.update(frame(), calmDrive, 1, 1, 1 / 60).keep).toBe(0)
    expect(model.update(frame(), calmDrive, 1, 1, 1 / 60).keep).toBeGreaterThan(0.99)
    model.reseed()
    expect(model.update(frame(), calmDrive, 1, 1, 1 / 60).keep).toBe(0)
  })

  it('keeps more of the field as emergence grows', () => {
    const keepAt = (e: number) => {
      const model = createDriftModel()
      model.update(frame(), calmDrive, e, 1, 1 / 60)
      return model.update(frame(), calmDrive, e, 1, 1 / 60).keep
    }
    expect(keepAt(0.1)).toBeLessThan(keepAt(0.5))
    expect(keepAt(0.5)).toBeLessThan(keepAt(1))
  })

  it.each([0.3, 1])('integrates the same at 30 and 120 fps (emergence %s)', (emergence) => {
    const slow = integrate(30, 2, emergence)
    const fast = integrate(120, 2, emergence)
    expect(fast.keep).toBeCloseTo(slow.keep, 6)
    expect(fast.survive).toBeCloseTo(slow.survive, 6)
    expect(fast.zoom).toBeCloseTo(slow.zoom, 6)
    expect(fast.spin).toBeCloseTo(slow.spin, 3)
  })

  it('zooms harder on bass and beats, and spins on mid', () => {
    const at = (audio: AnalysisFrame, drive = calmDrive): DriftParams => {
      const model = createDriftModel()
      return { ...model.update(audio, drive, 1, 1, 1 / 60) }
    }
    expect(at(frame({ bass: 1 })).zoom).toBeGreaterThan(at(frame({ bass: 0 })).zoom)
    expect(at(frame(), { pulse: 1, heat: 0 }).zoom).toBeGreaterThan(at(frame()).zoom)
    expect(Math.abs(at(frame({ mid: 1 })).spin)).toBeGreaterThan(
      Math.abs(at(frame({ mid: 0 })).spin)
    )
    expect(at(frame({ treble: 1 })).turbulence).toBeGreaterThan(at(frame({ treble: 0 })).turbulence)
  })

  it('hands the flash guard the present mix and the ring', () => {
    const model = createDriftModel()
    model.update(frame(), calmDrive, 1, 1, 1 / 60)
    const p = model.update(frame(), { pulse: 1, heat: 1 }, 1, 0, 1 / 60)
    expect(p.present).toBe(0)
    expect(p.ringAlpha).toBe(0)
  })

  it('fades the ring out when the music stops', () => {
    const model = createDriftModel()
    for (let i = 0; i < 60; i++) model.update(frame(), calmDrive, 1, 1, 1 / 60)
    const playing = model.params.ringAlpha
    for (let i = 0; i < 180; i++) model.update(frame({ silent: true }), calmDrive, 1, 1, 1 / 60)
    expect(playing).toBeGreaterThan(0.4)
    expect(model.params.ringAlpha).toBeLessThan(0.01)
  })

  it('encodes the darker ramp steps and ring colours, keyed on the palette version', () => {
    const model = createDriftModel()
    const source = palette(3)
    const colours = model.updateColours(source)
    const slot = PaletteSlot.primary950 * 3
    expect(colours.darkB[0]).toBeCloseTo(gammaEncode(source.linear[slot]), 6)
    source.linear[slot] = 0.99
    expect(model.updateColours(source).darkB[0]).not.toBeCloseTo(gammaEncode(0.99), 3)
    expect(model.updateColours({ ...source, version: 4 }).darkB[0]).toBeCloseTo(
      gammaEncode(0.99),
      6
    )
  })
})

describe('Drift field over 30 minutes', () => {
  /** A deterministic generator, so the run is reproducible. */
  function rng(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
  }

  /**
   * The shader's recurrence along one radius, warp included: each frame a cell
   * takes the field from `r / zoom` (the zoom carries everything outward; spin
   * and turbulence only move values sideways, so a radius loses nothing to
   * them), decays, takes the ring where the waveform puts it, and re-seeds.
   * Area-weighted by r, as the stage sees it.
   */
  it('neither saturates nor dies out', () => {
    const fps = 60
    const minutes = 30
    const cells = 400
    const maxRadius = 1 // the corner of a 16:9 stage, in units of height
    const random = rng(23)
    const model = createDriftModel()
    // Premultiplied: the wash at ~20 % opacity, a dark ramp step, a bright ring.
    const wash = { colour: 0.12, alpha: 0.22 }
    const dark = 0.06
    const ring = 0.95
    let colour = new Float64Array(cells).fill(wash.colour)
    let alpha = new Float64Array(cells).fill(wash.alpha)
    let nextColour = new Float64Array(cells)
    let nextAlpha = new Float64Array(cells)
    const radius = (cell: number) => ((cell + 0.5) / cells) * maxRadius
    const sample = (field: Float64Array, r: number) => {
      const x = Math.min(cells - 1, Math.max(0, (r / maxRadius) * cells - 0.5))
      const i = Math.floor(x)
      const j = Math.min(cells - 1, i + 1)
      return field[i] + (field[j] - field[i]) * (x - i)
    }
    const width = Math.max(RING_WIDTH, RING_WIDTH_MIN_PX / 1080)
    let areaTotal = 0
    for (let cell = 0; cell < cells; cell++) areaTotal += radius(cell)

    let pulse = 0
    let lo = Infinity
    let hi = -Infinity
    const means: number[] = []
    const total = fps * 60 * minutes
    for (let i = 0; i < total; i++) {
      // Sections that heat and cool over minutes, and a beat roughly twice a second.
      const t = i / fps
      const heat = 0.5 + 0.5 * Math.sin(t / 40)
      const onset = random() < 2 / fps ? 0.5 + 0.5 * random() : 0
      pulse = Math.max(onset, pulse * Math.exp(-1 / fps / 0.2))
      const p = model.update(
        frame({ bass: random() * heat, mid: random(), treble: random(), onset }),
        { pulse, heat },
        1,
        1,
        1 / fps
      )
      const ringAt = p.ringRadius + (random() * 2 - 1) * p.ringAmplitude
      let mean = 0
      for (let cell = 0; cell < cells; cell++) {
        const r = radius(cell)
        const mask = ringMask(r - ringAt, width)
        nextColour[cell] = driftStep(sample(colour, r / p.zoom), wash.colour, dark, ring, mask, p)
        nextAlpha[cell] = driftStep(sample(alpha, r / p.zoom), wash.alpha, 1, 1, mask, p)
        if (nextColour[cell] > nextAlpha[cell] + 1e-9) throw new Error('not premultiplied')
        if (nextColour[cell] < lo) lo = nextColour[cell]
        if (nextColour[cell] > hi) hi = nextColour[cell]
        mean += nextColour[cell] * r
      }
      ;[colour, nextColour] = [nextColour, colour]
      ;[alpha, nextAlpha] = [nextAlpha, alpha]
      if (i % fps === 0) means.push(mean / areaTotal)
    }

    // Bounded by its inputs: never past the brightest colour fed in, never under the darkest.
    expect(hi).toBeLessThanOrEqual(ring)
    expect(lo).toBeGreaterThanOrEqual(dark * 0.99)
    const tail = means.slice(-300) // the last five minutes, a sample a second
    const tailMax = Math.max(...tail)
    const tailMin = Math.min(...tail)
    // Not saturated: the field the ring leaves behind sits well under the ring itself.
    expect(tailMax).toBeLessThan(ring * 0.6)
    // Not dead: above the decay target, and still moving with the music.
    expect(tailMin).toBeGreaterThan(dark * 1.2)
    expect(tailMax - tailMin).toBeGreaterThan(0.01)
    // And the same picture after 30 minutes as after the first five: no drift either way.
    const early = means.slice(60, 360)
    const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
    expect(Math.abs(average(tail) - average(early))).toBeLessThan(0.05)
    // Most of the field is opaque by now: it grew out of the wash rather than staying it.
    expect(sample(alpha, 0.5)).toBeGreaterThan(0.6)
  })
})
