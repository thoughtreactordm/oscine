import { describe, expect, it } from 'vitest'
import { parseColor, rampFromSeed, SEED_STEP } from '@shared/theme'
import { mixSeeds, pickAccentSeed } from '../../src/renderer/theme/reactiveColor'

/** RGBA pixels from a list of `[r, g, b, count]` runs, the way a cover decomposes. */
function pixels(runs: readonly (readonly [number, number, number, number])[]): Uint8ClampedArray {
  const total = runs.reduce((sum, [, , , count]) => sum + count, 0)
  const data = new Uint8ClampedArray(total * 4)

  let offset = 0
  for (const [r, g, b, count] of runs) {
    for (let i = 0; i < count; i += 1) {
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
      offset += 4
    }
  }
  return data
}

/** The hue a seed carries, which is what the ramp is actually built from. */
function hueOf(seed: string): number {
  const parsed = parseColor(seed)
  expect(parsed).not.toBeNull()
  return parsed!.h
}

describe('pickAccentSeed', () => {
  it('takes the one colour on a flat cover', () => {
    const seed = pickAccentSeed(pixels([[220, 40, 40, 1000]]))
    expect(seed).not.toBeNull()
    // Red sits near 25-30° in OKLCH.
    expect(hueOf(seed!)).toBeGreaterThan(0)
    expect(hueOf(seed!)).toBeLessThan(60)
  })

  it('returns null for a monochrome cover rather than a grey accent', () => {
    // Every step of a grey ladder, which is exactly the case that must not
    // resolve: a grey seed would walk `rampFromSeed`'s neutral ladder and the
    // focus ring would stop being findable.
    expect(
      pickAccentSeed(
        pixels([
          [20, 20, 20, 400],
          [128, 128, 128, 400],
          [235, 235, 235, 400]
        ])
      )
    ).toBeNull()
  })

  it('ignores near-black and near-white, which are most of most covers', () => {
    const seed = pickAccentSeed(
      pixels([
        [0, 0, 0, 4000],
        [255, 255, 255, 4000],
        [30, 90, 200, 200]
      ])
    )
    expect(seed).not.toBeNull()
    // Blue, not the letterboxing.
    expect(hueOf(seed!)).toBeGreaterThan(230)
    expect(hueOf(seed!)).toBeLessThan(290)
  })

  it('prefers the vivid minority over the washed-out majority', () => {
    // The sepia case the cube-root damping exists for: a beige covering three
    // quarters of the sleeve against a red covering a twentieth.
    const seed = pickAccentSeed(
      pixels([
        [196, 176, 148, 3000],
        [212, 24, 30, 200]
      ])
    )
    expect(seed).not.toBeNull()
    expect(hueOf(seed!)).toBeGreaterThan(0)
    expect(hueOf(seed!)).toBeLessThan(50)
  })

  it('does not let a single speck take the whole accent', () => {
    // Same shape as above but the vivid region is four pixels rather than two
    // hundred, which is a logo or a compression artefact, not a colour scheme.
    const seed = pickAccentSeed(
      pixels([
        [70, 130, 180, 4000],
        [255, 0, 255, 4]
      ])
    )
    expect(seed).not.toBeNull()
    // Steel blue, not magenta.
    expect(hueOf(seed!)).toBeGreaterThan(220)
    expect(hueOf(seed!)).toBeLessThan(280)
  })

  it('holds a gradient together instead of splitting it across bins', () => {
    // Twelve shades walking one hue. Each alone is a twelfth of the cover and
    // would lose to the flat block; smoothed together they are three quarters
    // of it and win.
    const gradient = Array.from(
      { length: 12 },
      (_, i) => [40 + i * 4, 90 + i * 6, 190 + i * 4, 250] as const
    )
    const seed = pickAccentSeed(pixels([...gradient, [180, 120, 40, 900]]))
    expect(seed).not.toBeNull()
    expect(hueOf(seed!)).toBeGreaterThan(230)
    expect(hueOf(seed!)).toBeLessThan(290)
  })

  it('ignores fully transparent pixels', () => {
    const data = pixels([
      [220, 40, 40, 500],
      [30, 90, 200, 500]
    ])
    // Blank the blue half's alpha; the red must be the only thing left.
    for (let i = 500 * 4; i < data.length; i += 4) data[i + 3] = 0

    const seed = pickAccentSeed(data)
    expect(seed).not.toBeNull()
    expect(hueOf(seed!)).toBeLessThan(60)
  })

  it('returns null for no pixels at all', () => {
    expect(pickAccentSeed(new Uint8ClampedArray(0))).toBeNull()
  })

  it('emits the seed as the step 500 its own ramp produces', () => {
    // The property the accent's honesty rests on: what comes back is the colour
    // that will show, not an approximation the ramp then moves.
    const seed = pickAccentSeed(pixels([[30, 90, 200, 1000]]))
    expect(seed).not.toBeNull()
    expect(rampFromSeed(seed!)?.[SEED_STEP]).toBe(seed)
  })
})

describe('mixSeeds', () => {
  const red = '#d02020'
  const blue = '#2050d0'

  it('is its endpoints at 0 and 1', () => {
    expect(hueOf(mixSeeds(red, blue, 0))).toBeCloseTo(hueOf(red), 1)
    expect(hueOf(mixSeeds(red, blue, 1))).toBeCloseTo(hueOf(blue), 1)
  })

  it('keeps chroma up through the middle rather than passing through grey', () => {
    const middle = parseColor(mixSeeds(red, blue, 0.5))
    expect(middle).not.toBeNull()
    const ends = Math.min(parseColor(red)!.c, parseColor(blue)!.c)
    expect(middle!.c).toBeGreaterThan(ends * 0.8)
  })

  it('takes the short way round the hue circle', () => {
    // 350° to 10° is 20° the short way and 340° the long way. Passing through
    // 180° would swing a red-to-red fade through cyan.
    const from = 'oklch(0.6 0.15 350)'
    const to = 'oklch(0.6 0.15 10)'
    const middle = hueOf(mixSeeds(from, to, 0.5))
    expect(middle > 350 || middle < 10).toBe(true)
  })

  it('cuts to the target rather than throwing when an end will not parse', () => {
    expect(mixSeeds('not a colour', blue, 0.5)).toBe(blue)
  })
})
