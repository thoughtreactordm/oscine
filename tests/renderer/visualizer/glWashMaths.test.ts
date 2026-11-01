import { describe, expect, it } from 'vitest'
import { coverUvTransform, objectCoverUv } from '../../../src/renderer/visualizer/coverFit'
import { meanLuminance } from '../../../src/renderer/visualizer/luminance'
import {
  GAUSSIAN_MAX_TAPS,
  gaussianTapsInto,
  objectCoverCrop,
  saturateMatrix,
  WASH_TARGET_SIGMA
} from '../../../src/renderer/visualizer/wash'

/** W23-8, D35.11 / D35.12 / D35.8: the arithmetic under the WebGL tier's shaders. */

function apply(transform: ArrayLike<number>, u: number, v: number): [number, number] {
  return [u * transform[0] + transform[2], v * transform[1] + transform[3]]
}

describe('cover-fit UVs', () => {
  it('a square cover in a square box samples all of it, upright', () => {
    const t = coverUvTransform(1, 1)
    // Screen bottom-left (GL) is the cover's bottom-left: v-down = 1.
    expect(apply(t, 0, 0)).toEqual([0, 1])
    expect(apply(t, 1, 1)).toEqual([1, 0])
    expect(apply(t, 0.5, 0.5)).toEqual([0.5, 0.5])
  })

  it('a square cover in a 16:9 box shows a centred band of its height', () => {
    const t = coverUvTransform(1, 16 / 9)
    const [, bottom] = apply(t, 0, 0)
    const [, top] = apply(t, 0, 1)
    expect(top).toBeCloseTo((1 - 9 / 16) / 2, 10)
    expect(bottom).toBeCloseTo(1 - (1 - 9 / 16) / 2, 10)
    expect(apply(t, 0, 0)[0]).toBe(0)
    expect(apply(t, 1, 0)[0]).toBe(1)
  })

  it('a wide cover in a square box shows a centred band of its width', () => {
    const [sx, sy, ox, oy] = objectCoverUv(2, 1)
    expect([sx, sy, ox, oy]).toEqual([0.5, 1, 0.25, 0])
  })

  it('agrees with the 2D wash’s object-cover crop', () => {
    const coverW = 640
    const coverH = 480
    const boxW = 1600
    const boxH = 900
    const crop = objectCoverCrop(coverW, coverH, boxW, boxH)
    const t = coverUvTransform(coverW / coverH, boxW / boxH)
    const [left, bottom] = apply(t, 0, 0)
    const [right, top] = apply(t, 1, 1)
    expect(left * coverW).toBeCloseTo(crop.x, 6)
    expect(right * coverW).toBeCloseTo(crop.x + crop.width, 6)
    expect(top * coverH).toBeCloseTo(crop.y, 6)
    expect(bottom * coverH).toBeCloseTo(crop.y + crop.height, 6)
  })

  it('zoom shows the centre 1/zoom of the fitted cover, like scale() on the layer', () => {
    const t = coverUvTransform(1, 1, 1.25)
    expect(apply(t, 0, 1)[0]).toBeCloseTo(0.1, 10)
    expect(apply(t, 1, 1)[0]).toBeCloseTo(0.9, 10)
    expect(apply(t, 0.5, 0.5)).toEqual([0.5, 0.5])
  })

  it('writes into a given array, and treats nonsense as identity fit', () => {
    const out = new Float32Array(4)
    expect(coverUvTransform(1, 1, 1, out)).toBe(out)
    expect(objectCoverUv(0, 1)).toEqual([1, 1, 0, 0])
    expect(coverUvTransform(1, 1, 0)).toEqual(coverUvTransform(1, 1, 1))
  })
})

describe('gaussianTapsInto', () => {
  const offsets = new Float32Array(GAUSSIAN_MAX_TAPS)
  const weights = new Float32Array(GAUSSIAN_MAX_TAPS)

  function total(taps: number): number {
    let sum = weights[0]
    for (let index = 1; index < taps; index++) sum += 2 * weights[index]
    return sum
  }

  it('the ⅛-size target’s σ fits in 25 taps a pass', () => {
    const taps = gaussianTapsInto(WASH_TARGET_SIGMA, offsets, weights)
    expect(taps).toBe(GAUSSIAN_MAX_TAPS)
    expect(1 + 2 * (taps - 1)).toBe(25)
    expect(total(taps)).toBeCloseTo(1, 6)
  })

  it('has the variance of the Gaussian it stands for', () => {
    const sigma = 4
    const taps = gaussianTapsInto(sigma, offsets, weights)
    let variance = 0
    // A bilinear tap at offset o reads texels ⌊o⌋ and ⌊o⌋+1 in the split its
    // fraction sets, so the pair keeps the discrete kernel's second moment.
    for (let index = 1; index < taps; index++) {
      const o = offsets[index]
      const lo = Math.floor(o)
      const frac = o - lo
      variance += 2 * weights[index] * ((1 - frac) * lo * lo + frac * (lo + 1) * (lo + 1))
    }
    expect(Math.sqrt(variance)).toBeCloseTo(sigma, 1)
  })

  it('offsets rise and sit between the texel pairs they read', () => {
    const taps = gaussianTapsInto(6, offsets, weights)
    expect(offsets[0]).toBe(0)
    for (let index = 1; index < taps; index++) {
      const lo = 2 * index - 1
      expect(offsets[index]).toBeGreaterThanOrEqual(lo)
      expect(offsets[index]).toBeLessThanOrEqual(lo + 1)
    }
  })

  it('a huge σ truncates but stays normalised; no blur is one tap', () => {
    const taps = gaussianTapsInto(40, offsets, weights)
    expect(taps).toBe(GAUSSIAN_MAX_TAPS)
    expect(total(taps)).toBeCloseTo(1, 6)
    expect(gaussianTapsInto(0, offsets, weights)).toBe(1)
    expect(weights[0]).toBe(1)
    expect(offsets[1]).toBe(0)
  })
})

describe('saturateMatrix', () => {
  function mul(m: number[], rgb: [number, number, number]): number[] {
    return [0, 1, 2].map(
      (row) => m[row * 3] * rgb[0] + m[row * 3 + 1] * rgb[1] + m[row * 3 + 2] * rgb[2]
    )
  }

  it('is identity at 1 and luma at 0, per the Filter Effects spec', () => {
    const identity = saturateMatrix(1)
    expect(identity.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    const grey = mul(saturateMatrix(0), [1, 0, 0])
    expect(grey).toEqual([0.213, 0.213, 0.213])
  })

  it('leaves greys alone at any amount', () => {
    const out = mul(saturateMatrix(2.2), [0.4, 0.4, 0.4])
    for (const channel of out) expect(channel).toBeCloseTo(0.4, 10)
  })
})

describe('meanLuminance', () => {
  it('weights by alpha and reads straight or premultiplied bytes alike', () => {
    const straight = [255, 255, 255, 128, 0, 0, 0, 0]
    const premultiplied = [128, 128, 128, 128, 0, 0, 0, 0]
    const expected = (1 * (128 / 255)) / 2
    expect(meanLuminance(straight, false)).toBeCloseTo(expected, 6)
    expect(meanLuminance(premultiplied, true)).toBeCloseTo(expected, 6)
  })

  it('is zero for nothing and for transparency', () => {
    expect(meanLuminance([], false)).toBe(0)
    expect(meanLuminance([255, 255, 255, 0], true)).toBe(0)
  })
})
