import { describe, expect, it, vi } from 'vitest'
import { gammaDecode } from '@shared/theme'
import {
  SWATCH_COUNT,
  SWATCH_GRID,
  SYNTHETIC_COVER_EDGE,
  computeSwatches,
  createCoverCrossfade,
  fillSyntheticCover,
  syntheticCoverField,
  type CoverSlot
} from '../../../src/renderer/visualizer/cover'
import { PALETTE_LERP_SEC, PaletteSlot } from '../../../src/renderer/visualizer/palette'

const FRAME = 1 / 60

/** RGBA pixels, `width × height`, coloured by `paint(x, y)`. */
function image(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number?]
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y)
      pixels.set([r, g, b, a], (y * width + x) * 4)
    }
  }
  return pixels
}

function swatch(swatches: Float32Array, cx: number, cy: number): number[] {
  const i = (cy * SWATCH_GRID + cx) * 3
  return Array.from(swatches.subarray(i, i + 3))
}

interface FakeSlot extends CoverSlot {
  readonly name: string
  readonly closes: () => number
}

function slot(name: string, synthetic = false): FakeSlot {
  const close = vi.fn()
  return {
    name,
    closes: () => close.mock.calls.length,
    bitmap: { width: 640, height: 640, close },
    texture: null,
    aspect: 1,
    swatches: new Float32Array(SWATCH_COUNT * 3),
    synthetic
  }
}

function run(seconds: number, step: (dt: number) => void): void {
  for (let t = 0; t < seconds; t += FRAME) step(FRAME)
}

describe('computeSwatches', () => {
  it('finds both colours of a two-colour image, in linear light', () => {
    const red: [number, number, number] = [220, 30, 40]
    const blue: [number, number, number] = [20, 60, 200]
    const pixels = image(64, 48, (x) => (x < 32 ? red : blue))
    const swatches = computeSwatches(pixels, 64, 48)

    expect(swatches).toHaveLength(SWATCH_COUNT * 3)
    const linear = (c: [number, number, number]): number[] => c.map((v) => gammaDecode(v / 255))
    for (let cy = 0; cy < SWATCH_GRID; cy++) {
      for (let cx = 0; cx < SWATCH_GRID; cx++) {
        const expected = linear(cx < 2 ? red : blue)
        swatch(swatches, cx, cy).forEach((v, c) => expect(v).toBeCloseTo(expected[c] ?? 0, 5))
      }
    }
  })

  it('averages a split cell in linear light, not in sRGB bytes', () => {
    // A 4×4 image is one pixel per cell, so an 8×4 one puts two in each.
    const pixels = image(8, 4, (x) => (x % 2 === 0 ? [255, 0, 0] : [0, 0, 255]))
    const [r, g, b] = swatch(computeSwatches(pixels, 8, 4), 0, 0)
    expect(r).toBeCloseTo(0.5, 5)
    expect(g).toBe(0)
    expect(b).toBeCloseTo(0.5, 5)
  })

  it('weights by alpha, and leaves an empty cell black', () => {
    const pixels = image(8, 8, (x, y) => {
      if (y < 2 && x < 2) return [0, 0, 0, 0] // cell (0,0): fully transparent
      if (y < 2 && x < 4) return x === 2 ? [255, 255, 255, 255] : [0, 0, 0, 0] // cell (1,0)
      return [128, 128, 128, 255]
    })
    const swatches = computeSwatches(pixels, 8, 8)
    expect(swatch(swatches, 0, 0)).toEqual([0, 0, 0])
    swatch(swatches, 1, 0).forEach((v) => expect(v).toBeCloseTo(1, 5))
  })

  it('still fills every cell from an image smaller than the grid', () => {
    const pixels = image(2, 1, (x) => (x === 0 ? [255, 0, 0] : [0, 255, 0]))
    const swatches = computeSwatches(pixels, 2, 1)
    expect(swatch(swatches, 0, 3)).toEqual([1, 0, 0])
    expect(swatch(swatches, 3, 3)).toEqual([0, 1, 0])
  })
})

describe('synthetic stand-in', () => {
  it('keeps its field in 0..1 and actually varies', () => {
    let min = 1
    let max = 0
    for (let y = 0; y <= 32; y++) {
      for (let x = 0; x <= 32; x++) {
        const t = syntheticCoverField(x / 32, y / 32)
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThanOrEqual(1)
        min = Math.min(min, t)
        max = Math.max(max, t)
      }
    }
    expect(max - min).toBeGreaterThan(0.6)
  })

  it('paints an opaque field over the primary ramp, light at the glow and dark in the far corner', () => {
    const oklab = new Float32Array(16 * 3)
    // A grey ramp from L = 0.95 (primary-50) to L = 0.15 (primary-950).
    for (let slot = PaletteSlot.primary50; slot <= PaletteSlot.primary950; slot++) {
      oklab[slot * 3] = 0.95 - (0.8 * slot) / 10
    }
    const edge = SYNTHETIC_COVER_EDGE
    const pixels = fillSyntheticCover(oklab, new Uint8ClampedArray(edge * edge * 4))
    const at = (x: number, y: number): number => pixels[(y * edge + x) * 4] ?? 0

    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255)
    const glow = at(Math.round(edge * 0.32), Math.round(edge * 0.28))
    const corner = at(edge - 1, edge - 1)
    expect(glow).toBeGreaterThan(corner + 100)
  })

  it('follows the palette: a new ramp repaints the same field in new colours', () => {
    const edge = 16
    const warm = new Float32Array(16 * 3)
    const cool = new Float32Array(16 * 3)
    for (let slot = 0; slot < 11; slot++) {
      warm[slot * 3] = cool[slot * 3] = 0.6
      warm[slot * 3 + 1] = 0.12
      cool[slot * 3 + 2] = -0.12
    }
    const a = fillSyntheticCover(warm, new Uint8ClampedArray(edge * edge * 4), edge)
    const b = fillSyntheticCover(cool, new Uint8ClampedArray(edge * edge * 4), edge)
    expect(a[0]).toBeGreaterThan(a[2] ?? 0) // red over blue
    expect(b[2]).toBeGreaterThan(b[0] ?? 0)
  })
})

describe('createCoverCrossfade', () => {
  it('lands the first cover at once', () => {
    const fade = createCoverCrossfade<FakeSlot>()
    expect(fade.input).toBeNull()
    const a = slot('A')
    fade.present(a)
    expect(fade.input).toMatchObject({ current: a, previous: null, mix: 1 })
    expect(fade.fading).toBe(false)
  })

  it('crossfades A→B over the palette lerp, then closes A exactly once', () => {
    const fade = createCoverCrossfade<FakeSlot>()
    const a = slot('A')
    const b = slot('B')
    fade.present(a)
    const input = fade.input
    fade.present(b)
    expect(fade.input).toBe(input) // the same object, updated in place
    expect(fade.input).toMatchObject({ current: b, previous: a, mix: 0 })

    let last = 0
    let elapsed = 0
    while (fade.fading) {
      fade.update(FRAME)
      elapsed += FRAME
      const mix = fade.input?.mix ?? 0
      expect(mix).toBeGreaterThanOrEqual(last)
      last = mix
    }
    expect(elapsed).toBeCloseTo(PALETTE_LERP_SEC, 1)
    expect(fade.input).toMatchObject({ current: b, previous: null, mix: 1 })
    expect(a.closes()).toBe(1)
    expect(b.closes()).toBe(0)

    run(1, (dt) => fade.update(dt))
    expect(a.closes()).toBe(1)
  })

  it('A→B→C mid-fade drops and closes B, keeps fading from A, never holds three', () => {
    const fade = createCoverCrossfade<FakeSlot>()
    const [a, b, c] = [slot('A'), slot('B'), slot('C')]
    fade.present(a)
    fade.present(b)
    run(0.2, (dt) => fade.update(dt))
    const mixBefore = fade.input?.mix ?? 0
    expect(mixBefore).toBeGreaterThan(0)

    fade.present(c)
    expect(b.closes()).toBe(1)
    expect(fade.input).toMatchObject({ current: c, previous: a })
    expect(fade.input?.mix).toBe(mixBefore) // no jump back towards A

    run(1, (dt) => fade.update(dt))
    expect(fade.input).toMatchObject({ current: c, previous: null, mix: 1 })
    expect([a.closes(), b.closes(), c.closes()]).toEqual([1, 1, 0])
  })

  it('A→none crossfades to the stand-in and closes A', () => {
    const fade = createCoverCrossfade<FakeSlot>()
    const a = slot('A')
    const none = slot('stand-in', true)
    fade.present(a)
    fade.present(none)
    expect(fade.input).toMatchObject({ current: none, previous: a, mix: 0 })
    run(1, (dt) => fade.update(dt))
    expect(fade.input).toMatchObject({ current: none, previous: null, mix: 1 })
    expect(a.closes()).toBe(1)
  })

  it('replaceCurrent swaps without a fade and releases the old slot', () => {
    const fade = createCoverCrossfade<FakeSlot>()
    const s1 = slot('s1', true)
    const s2 = slot('s2', true)
    fade.present(s1)
    fade.replaceCurrent(s2)
    expect(fade.input).toMatchObject({ current: s2, previous: null, mix: 1 })
    expect(s1.closes()).toBe(1)
  })

  it('re-presenting the outgoing cover cuts to it instead of holding it twice', () => {
    const fade = createCoverCrossfade<FakeSlot>()
    const [a, b] = [slot('A'), slot('B')]
    fade.present(a)
    fade.present(b)
    fade.update(0.1)
    fade.present(a)
    expect(fade.input).toMatchObject({ current: a, previous: null, mix: 1 })
    expect([a.closes(), b.closes()]).toEqual([0, 1])
  })

  it('clear closes every live bitmap exactly once', () => {
    const fade = createCoverCrossfade<FakeSlot>()
    const [a, b] = [slot('A'), slot('B')]
    fade.present(a)
    fade.present(b)
    fade.update(0.1)
    fade.clear()
    fade.clear()
    expect(fade.input).toBeNull()
    expect([a.closes(), b.closes()]).toEqual([1, 1])
  })

  it('is frame-rate independent', () => {
    const at = (fps: number): number => {
      const fade = createCoverCrossfade<FakeSlot>()
      fade.present(slot('A'))
      fade.present(slot('B'))
      for (let i = 0; i < 0.25 * fps; i++) fade.update(1 / fps)
      return fade.input?.mix ?? 0
    }
    expect(at(30)).toBeCloseTo(at(120), 1)
  })
})
