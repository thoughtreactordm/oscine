import { describe, expect, it } from 'vitest'
import {
  RAMP_STEPS,
  SEED_STEP,
  TAILWIND_PALETTES,
  TAILWIND_PALETTE_NAMES,
  describeRamp,
  isTailwindPalette,
  parseColor,
  rampFromSeed,
  resolveRamp,
  type RampSteps
} from '@shared/theme'

function lightness(value: string): number {
  const parsed = parseColor(value)
  expect(parsed, `failed to parse ${value}`).not.toBeNull()
  return parsed!.l
}

function chroma(value: string): number {
  return parseColor(value)!.c
}

describe('the generated Tailwind palettes', () => {
  it('carries every ramp with all eleven steps', () => {
    expect(TAILWIND_PALETTE_NAMES.length).toBeGreaterThanOrEqual(22)
    for (const name of TAILWIND_PALETTE_NAMES) {
      const palette = TAILWIND_PALETTES[name]!
      for (const step of RAMP_STEPS) {
        expect(parseColor(palette[step]), `${name}-${step}`).not.toBeNull()
      }
    }
  })

  it('holds the palettes the built-in themes name', () => {
    for (const name of ['amber', 'taupe', 'slate', 'blue', 'sky', 'red', 'green', 'orange']) {
      expect(isTailwindPalette(name), name).toBe(true)
    }
    expect(isTailwindPalette('burgundy')).toBe(false)
  })

  it('walks monotonically darker from 50 to 950', () => {
    for (const name of TAILWIND_PALETTE_NAMES) {
      const palette = TAILWIND_PALETTES[name]!
      for (let i = 1; i < RAMP_STEPS.length; i += 1) {
        const prev = lightness(palette[RAMP_STEPS[i - 1]!]!)
        const here = lightness(palette[RAMP_STEPS[i]!]!)
        expect(here, `${name} ${RAMP_STEPS[i - 1]} -> ${RAMP_STEPS[i]}`).toBeLessThan(prev)
      }
    }
  })
})

describe('rampFromSeed', () => {
  it('derives eleven in-gamut steps from one colour', () => {
    const ramp = rampFromSeed('oklch(64% 0.115 197)')
    expect(ramp).not.toBeNull()
    for (const step of RAMP_STEPS) {
      expect(parseColor(ramp![step]), step).not.toBeNull()
    }
  })

  it('holds the seed hue across the whole ramp', () => {
    const ramp = rampFromSeed('oklch(64% 0.115 197)')!
    for (const step of RAMP_STEPS) {
      const parsed = parseColor(ramp[step])!
      // Near-achromatic ends have no meaningful hue to hold.
      if (parsed.c > 0.01) expect(parsed.h, step).toBeCloseTo(197, 0)
    }
  })

  it('walks monotonically darker, like the palettes it imitates', () => {
    const ramp = rampFromSeed('oklch(64% 0.115 197)')!
    for (let i = 1; i < RAMP_STEPS.length; i += 1) {
      expect(lightness(ramp[RAMP_STEPS[i]!]!)).toBeLessThan(lightness(ramp[RAMP_STEPS[i - 1]!]!))
    }
  })

  it('carries the most chroma at the seed step', () => {
    const ramp = rampFromSeed('oklch(64% 0.115 197)')!
    const seedChroma = chroma(ramp[SEED_STEP])
    for (const step of RAMP_STEPS) {
      if (step === SEED_STEP) continue
      expect(chroma(ramp[step]), step).toBeLessThanOrEqual(seedChroma + 1e-6)
    }
  })

  it('discards the seed lightness so a pale seed still has a dark end', () => {
    // A ramp that honoured a 95% seed would have no dark end at all, and every
    // surface built on it would be unreadable.
    const pale = rampFromSeed('oklch(95% 0.05 197)')!
    expect(lightness(pale['950'])).toBeLessThan(0.4)
    expect(lightness(pale['50'])).toBeGreaterThan(0.9)
  })

  it('clamps an impossible chroma into sRGB rather than emitting a colour no display shows', () => {
    const ramp = rampFromSeed('oklch(64% 0.4 197)')!
    for (const step of RAMP_STEPS) {
      const parsed = parseColor(ramp[step])!
      expect(parsed.c, step).toBeLessThan(0.4)
    }
  })

  it('returns null for a seed it cannot read', () => {
    expect(rampFromSeed('not a colour')).toBeNull()
    expect(rampFromSeed('rebeccapurple')).toBeNull()
  })

  it('walks the neutral ladder for a grey, not the chromatic one', () => {
    // Regression: a grey on the chromatic ladder comes out far too light
    // through the middle, and since every surface and text weight is a step of
    // the neutral ramp, the result is body text that cannot reach 4.5:1
    // against its own background.
    const grey = rampFromSeed('oklch(62% 0.014 235)')!
    const colour = rampFromSeed('oklch(62% 0.115 197)')!
    expect(lightness(grey['500'])).toBeLessThan(lightness(colour['500']))
    // Close to where Tailwind's own greys sit, rather than to its colours.
    expect(lightness(grey['500'])).toBeCloseTo(lightness(TAILWIND_PALETTES.slate!['500']), 1)
  })

  it('treats a tinted grey as a grey', () => {
    // A neutral shifted a few degrees towards blue is still a neutral, and a
    // threshold that missed it would reintroduce the bug above for exactly the
    // ramps most likely to be authored.
    const tinted = rampFromSeed('oklch(62% 0.03 235)')!
    expect(lightness(tinted['500'])).toBeCloseTo(lightness(TAILWIND_PALETTES.slate!['500']), 1)
  })
})

describe('resolveRamp', () => {
  it('resolves all three authoring modes to the same shape', () => {
    const fromPalette = resolveRamp({ mode: 'palette', palette: 'amber' })
    const fromSeed = resolveRamp({ mode: 'seed', seed: '#f59e0b' })
    const fromCustom = resolveRamp({
      mode: 'custom',
      steps: TAILWIND_PALETTES.amber as RampSteps
    })

    for (const ramp of [fromPalette, fromSeed, fromCustom]) {
      expect(ramp).not.toBeNull()
      expect(Object.keys(ramp!).sort()).toEqual([...RAMP_STEPS].sort())
    }
  })

  it('returns null rather than a fallback nobody chose', () => {
    expect(resolveRamp({ mode: 'palette', palette: 'burgundy' })).toBeNull()
    expect(resolveRamp({ mode: 'seed', seed: 'nonsense' })).toBeNull()
  })

  it('rejects a custom ramp with an unreadable step', () => {
    const broken = { ...(TAILWIND_PALETTES.amber as RampSteps), '500': 'nonsense' }
    expect(resolveRamp({ mode: 'custom', steps: broken })).toBeNull()
  })
})

describe('describeRamp', () => {
  it('recognises a Tailwind ramp so the editor opens on the mode last used', () => {
    const spec = describeRamp(TAILWIND_PALETTES.amber as RampSteps)
    expect(spec).toEqual({ mode: 'palette', palette: 'amber' })
  })

  it('recognises a seed-derived ramp from its own 500', () => {
    const seed = 'oklch(64% 0.115 197)'
    const derived = rampFromSeed(seed)!
    const spec = describeRamp(derived)
    expect(spec.mode).toBe('seed')
    // The reported seed re-derives the identical ramp, which is the property
    // that matters — not that it is spelled the same as the original input.
    if (spec.mode === 'seed') expect(rampFromSeed(spec.seed)).toEqual(derived)
  })

  it('falls back to custom for a ramp that is neither', () => {
    const handmade = { ...(TAILWIND_PALETTES.amber as RampSteps), '300': 'oklch(80% 0.1 300)' }
    expect(describeRamp(handmade).mode).toBe('custom')
  })
})
