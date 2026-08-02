import { describe, expect, it } from 'vitest'
import {
  blurBins,
  createWaveformShaper,
  easeBins,
  fillBinPeaks
} from '../../../src/renderer/panels/waveformRibbon'

/** A window with one loud sample parked at `index` and silence either side. */
function spike(length: number, index: number, level = 1): Float32Array {
  const samples = new Float32Array(length)
  samples[index] = level
  return samples
}

describe('fillBinPeaks', () => {
  it('reports the peak magnitude under each bin, not the average', () => {
    // Four samples per bin, one of them loud. An RMS would report 0.25 here and
    // the transient would vanish; the peak is the whole reason this is a peak.
    const samples = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])
    const bins = new Float32Array(2)

    fillBinPeaks(samples, bins)

    expect([...bins]).toEqual([1, 0])
  })

  it('treats a trough as loud as a crest', () => {
    const bins = new Float32Array(1)

    fillBinPeaks(new Float32Array([-0.8, 0.2]), bins)

    expect(bins[0]).toBeCloseTo(0.8)
  })

  it('covers the whole window when the bins do not divide it evenly', () => {
    // 10 samples over 3 bins. The last sample must still be able to move the
    // shape, or the right-hand edge of the ribbon would be permanently deaf.
    const bins = new Float32Array(3)

    fillBinPeaks(spike(10, 9), bins)

    expect(bins[2]).toBe(1)
  })

  it('gives every bin a sample when the window is narrower than the strip', () => {
    const bins = new Float32Array(8)

    fillBinPeaks(new Float32Array([1, 1, 1, 1]), bins)

    expect([...bins].every((value) => value === 1)).toBe(true)
  })

  it('zeroes the bins for an empty window rather than leaving the last shape', () => {
    const bins = new Float32Array([0.5, 0.5])

    fillBinPeaks(new Float32Array(0), bins)

    expect([...bins]).toEqual([0, 0])
  })
})

describe('blurBins', () => {
  it('spreads a single loud bin into its neighbours', () => {
    const values = new Float32Array([0, 0, 3, 0, 0])
    const scratch = new Float32Array(5)

    blurBins(values, scratch, 1)

    expect(values[1]).toBeCloseTo(1)
    expect(values[2]).toBeCloseTo(1)
    expect(values[3]).toBeCloseTo(1)
    expect(values[0]).toBeCloseTo(0)
  })

  it('clamps at the edges instead of wrapping', () => {
    // If the ends wrapped, the loud bin on the left would light up the right.
    const values = new Float32Array([1, 0, 0, 0])
    const scratch = new Float32Array(4)

    blurBins(values, scratch, 1)

    expect(values[3]).toBe(0)
    expect(values[0]).toBeCloseTo(0.5)
  })

  it('leaves the shape untouched at radius zero', () => {
    const values = new Float32Array([0, 1, 0])
    const scratch = new Float32Array(3)

    blurBins(values, scratch, 0)

    expect([...values]).toEqual([0, 1, 0])
  })
})

describe('easeBins', () => {
  it('rises faster than it falls', () => {
    const rising = new Float32Array([0])
    const falling = new Float32Array([1])

    easeBins(rising, new Float32Array([1]))
    easeBins(falling, new Float32Array([0]))

    // Distance travelled toward the goal, on the same one frame.
    expect(rising[0]).toBeGreaterThan(1 - falling[0])
  })

  it('settles to exactly zero so a decayed ribbon can stop drawing', () => {
    const bins = new Float32Array([1])
    const silence = new Float32Array([0])

    let active = true
    for (let frame = 0; frame < 500 && active; frame += 1) {
      active = easeBins(bins, silence)
    }

    expect(active).toBe(false)
    expect(bins[0]).toBe(0)
  })

  it('stays active while any bin is above zero', () => {
    const bins = new Float32Array([0, 0])

    expect(easeBins(bins, new Float32Array([0, 1]))).toBe(true)
  })
})

describe('createWaveformShaper', () => {
  it('starts flat and inactive', () => {
    const shaper = createWaveformShaper({ bins: 8 })

    expect(shaper.active).toBe(false)
    expect([...shaper.bins].every((value) => value === 0)).toBe(true)
  })

  it('approaches the signal over several frames rather than snapping to it', () => {
    const shaper = createWaveformShaper({ bins: 4, blurRadius: 0 })
    const loud = new Float32Array(64).fill(1)

    shaper.push(loud)
    const first = shaper.bins[0]
    shaper.push(loud)
    const second = shaper.bins[0]

    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(1)
    expect(second).toBeGreaterThan(first)
    expect(shaper.active).toBe(true)
  })

  it('relaxes to inactive when nothing is sounding', () => {
    const shaper = createWaveformShaper({ bins: 4, blurRadius: 0 })
    shaper.push(new Float32Array(64).fill(1))

    for (let frame = 0; frame < 500 && shaper.active; frame += 1) shaper.relax()

    expect(shaper.active).toBe(false)
    expect([...shaper.bins].every((value) => value === 0)).toBe(true)
  })

  it('reuses its buffers across frames', () => {
    const shaper = createWaveformShaper({ bins: 4 })
    const before = shaper.bins

    shaper.push(new Float32Array(64).fill(0.5))

    expect(shaper.bins).toBe(before)
  })

  it('refuses a zero-bin strip rather than dividing by it', () => {
    const shaper = createWaveformShaper({ bins: 0 })

    shaper.push(new Float32Array(64).fill(1))

    expect(shaper.bins).toHaveLength(1)
  })
})
