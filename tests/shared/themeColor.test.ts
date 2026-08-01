import { describe, expect, it } from 'vitest'
import {
  clampToGamut,
  contrastRatio,
  formatOklch,
  isOutOfGamut,
  oklch,
  parseColor,
  relativeLuminance,
  toHex
} from '@shared/theme'

/** Parse or fail loudly — a null here would otherwise assert as `undefined`. */
function colour(input: string) {
  const parsed = parseColor(input)
  expect(parsed, `failed to parse ${input}`).not.toBeNull()
  return parsed!
}

describe('parseColor', () => {
  it('reads the three formats the editor accepts', () => {
    expect(parseColor('#fff')).not.toBeNull()
    expect(parseColor('#ffffff')).not.toBeNull()
    expect(parseColor('#ffffffff')).not.toBeNull()
    expect(parseColor('rgb(255, 255, 255)')).not.toBeNull()
    expect(parseColor('rgba(255, 255, 255, 0.5)')).not.toBeNull()
    expect(parseColor('oklch(100% 0 0)')).not.toBeNull()
    expect(parseColor('oklch(62.8% 0.258 29.23 / 0.4)')).not.toBeNull()
  })

  it('returns null rather than throwing on what it cannot vouch for', () => {
    // Named colours are deliberately unsupported: the contrast checker has to
    // understand every format the editor accepts.
    expect(parseColor('rebeccapurple')).toBeNull()
    expect(parseColor('color-mix(in oklch, red, blue)')).toBeNull()
    expect(parseColor('#ff')).toBeNull()
    expect(parseColor('oklch(50%)')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor('var(--something)')).toBeNull()
  })

  it('reads white and black at the ends of the lightness range', () => {
    expect(colour('#ffffff').l).toBeCloseTo(1, 2)
    expect(colour('#000000').l).toBeCloseTo(0, 2)
  })

  it('treats a shorthand hex as its expanded form', () => {
    expect(formatOklch(colour('#abc'))).toBe(formatOklch(colour('#aabbcc')))
  })

  it('carries alpha through from every format that states it', () => {
    expect(colour('#ff000080').alpha).toBeCloseTo(0.502, 2)
    expect(colour('rgba(255, 0, 0, 0.25)').alpha).toBeCloseTo(0.25, 3)
    expect(colour('oklch(62% 0.25 29 / 0.25)').alpha).toBeCloseTo(0.25, 3)
  })

  it('reports no hue for a grey instead of a numerically arbitrary one', () => {
    // atan2 on two near-zero components is noise; a grey that acquired a hue
    // would produce a tinted ramp when used as a seed.
    expect(colour('#808080').c).toBeLessThan(0.001)
    expect(colour('#808080').h).toBe(0)
  })
})

describe('round trips', () => {
  it('survives hex to OKLCH and back', () => {
    for (const hex of [
      '#000000',
      '#ffffff',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#1e293b',
      '#f59e0b'
    ]) {
      expect(toHex(colour(hex))).toBe(hex)
    }
  })

  it('survives OKLCH to string and back', () => {
    const original = oklch(0.6273, 0.2581, 29.23, 1)
    const reparsed = colour(formatOklch(original))
    expect(reparsed.l).toBeCloseTo(original.l, 3)
    expect(reparsed.c).toBeCloseTo(original.c, 3)
    expect(reparsed.h).toBeCloseTo(original.h, 1)
  })

  it('omits alpha from the canonical form when it is opaque', () => {
    expect(formatOklch(oklch(0.5, 0.1, 200, 1))).not.toContain('/')
    expect(formatOklch(oklch(0.5, 0.1, 200, 0.5))).toContain('/')
  })
})

describe('gamut', () => {
  it('flags a chroma sRGB cannot hold', () => {
    expect(isOutOfGamut(oklch(0.6, 0.4, 150))).toBe(true)
    expect(isOutOfGamut(oklch(0.6, 0.05, 150))).toBe(false)
  })

  it('gives up chroma and keeps lightness and hue', () => {
    const clamped = clampToGamut(oklch(0.6, 0.4, 150))
    expect(isOutOfGamut(clamped)).toBe(false)
    // Lightness is the ramp's whole reason for existing; chroma is negotiable.
    expect(clamped.l).toBeCloseTo(0.6, 5)
    expect(clamped.h).toBeCloseTo(150, 5)
    expect(clamped.c).toBeLessThan(0.4)
  })

  it('leaves an in-gamut colour identical', () => {
    const inside = oklch(0.6, 0.05, 150)
    expect(clampToGamut(inside)).toBe(inside)
  })
})

describe('relativeLuminance', () => {
  it('matches the WCAG anchors', () => {
    expect(relativeLuminance(colour('#ffffff'))).toBeCloseTo(1, 3)
    expect(relativeLuminance(colour('#000000'))).toBeCloseTo(0, 4)
    // The mid-grey WCAG examples cite.
    expect(relativeLuminance(colour('#808080'))).toBeCloseTo(0.2159, 3)
  })

  it('weights green far above blue', () => {
    expect(relativeLuminance(colour('#00ff00'))).toBeGreaterThan(
      relativeLuminance(colour('#0000ff'))
    )
  })
})

describe('contrastRatio', () => {
  it('reaches 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio(colour('#000000'), colour('#ffffff'))).toBeCloseTo(21, 2)
    expect(contrastRatio(colour('#ffffff'), colour('#ffffff'))).toBeCloseTo(1, 5)
  })

  it('is symmetric for opaque colours', () => {
    const a = colour('#1e293b')
    const b = colour('#f8fafc')
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 6)
  })

  it('composites a transparent foreground over its background', () => {
    // The same 50% black reads differently over white than over grey, which is
    // exactly why the uncomposited value would be the wrong measurement.
    const overWhite = contrastRatio(colour('oklch(0% 0 0 / 0.5)'), colour('#ffffff'))
    const overGrey = contrastRatio(colour('oklch(0% 0 0 / 0.5)'), colour('#808080'))
    expect(overWhite).toBeGreaterThan(overGrey)
    expect(overWhite).toBeLessThan(21)
  })

  it('reports no contrast for a fully transparent foreground', () => {
    expect(contrastRatio(colour('oklch(0% 0 0 / 0)'), colour('#ffffff'))).toBeCloseTo(1, 5)
  })
})
