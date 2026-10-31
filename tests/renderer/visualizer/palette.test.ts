import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_THEMES,
  HIGH_CONTRAST_THEME_ID,
  RAMP_STEPS,
  oklabToLinearRgbInto,
  resolveTheme,
  type ThemeMode
} from '@shared/theme'
import {
  PALETTE_LERP_SEC,
  PALETTE_PROPERTIES,
  PALETTE_SLOT_COUNT,
  PaletteSlot,
  createPaletteModel,
  type Palette,
  type PaletteModel
} from '../../../src/renderer/visualizer/palette'

const FRAME = 1 / 60

/** The value `getComputedStyle` would give for each palette property under `themeId`. */
function themeTokens(themeId: string, mode: ThemeMode): Map<string, string> {
  const theme = BUILT_IN_THEMES.find((t) => t.id === themeId)
  if (!theme) throw new Error(`no theme ${themeId}`)
  const vars = resolveTheme({ theme, mode }).cssVars
  // bridge.css: the `--ui-*` names the palette reads are aliases of these.
  const alias: Record<string, string> = {
    '--ui-primary': '--oscine-accent-primary',
    '--ui-bg': '--oscine-surface-base',
    '--ui-bg-elevated': '--oscine-surface-elevated',
    '--ui-text-highlighted': '--oscine-text-highlighted',
    '--ui-text-muted': '--oscine-text-muted'
  }
  const tokens = new Map<string, string>()
  for (const property of PALETTE_PROPERTIES) {
    const value = vars.get(alias[property] ?? property)
    if (value === undefined) throw new Error(`${themeId}/${mode} has no ${property}`)
    tokens.set(property, value)
  }
  return tokens
}

/** Every slot the same colour, for lerp tests that only care about one line. */
function uniform(color: string): Map<string, string> {
  return new Map(PALETTE_PROPERTIES.map((p) => [p, color]))
}

function lab(palette: Palette, slot: number): [number, number, number] {
  const i = slot * 3
  return [palette.oklab[i] ?? NaN, palette.oklab[i + 1] ?? NaN, palette.oklab[i + 2] ?? NaN]
}

function run(model: PaletteModel, seconds: number, each?: (t: number) => void): void {
  const frames = Math.round(seconds / FRAME)
  for (let f = 1; f <= frames; f++) {
    model.update(FRAME)
    each?.(f * FRAME)
  }
}

const BLUE = '#2563eb'
const YELLOW = '#facc15'
const RED = '#dc2626'

function settledLab(color: string): [number, number, number] {
  const model = createPaletteModel()
  model.setTarget(uniform(color))
  return lab(model.palette, 0)
}

describe('the palette slots', () => {
  it('reads every primary step, the accent, the surfaces and the text tokens', () => {
    expect(PALETTE_SLOT_COUNT).toBe(RAMP_STEPS.length + 5)
    expect(PALETTE_PROPERTIES[PaletteSlot.primary50]).toBe('--oscine-color-primary-50')
    expect(PALETTE_PROPERTIES[PaletteSlot.primary500]).toBe('--oscine-color-primary-500')
    expect(PALETTE_PROPERTIES[PaletteSlot.primary950]).toBe('--oscine-color-primary-950')
    expect(PALETTE_PROPERTIES[PaletteSlot.accent]).toBe('--ui-primary')
    expect(PALETTE_PROPERTIES[PaletteSlot.bg]).toBe('--ui-bg')
    expect(PALETTE_PROPERTIES[PaletteSlot.bgElevated]).toBe('--ui-bg-elevated')
    expect(PALETTE_PROPERTIES[PaletteSlot.textHighlighted]).toBe('--ui-text-highlighted')
    expect(PALETTE_PROPERTIES[PaletteSlot.textMuted]).toBe('--ui-text-muted')
  })

  it('exposes each colour as a CSS string and as linear RGB', () => {
    const model = createPaletteModel()
    model.setTarget(uniform('#ff0000'))
    const { css, linear } = model.palette
    expect(css[PaletteSlot.bg]).toBe('rgb(255 0 0)')
    const i = PaletteSlot.bg * 3
    expect(linear[i]).toBeCloseTo(1, 4)
    expect(linear[i + 1]).toBeCloseTo(0, 4)
    expect(linear[i + 2]).toBeCloseTo(0, 4)
    expect(linear.length).toBe(PALETTE_SLOT_COUNT * 3)
  })

  it('lands the first target at once, and reports what it could not parse', () => {
    const model = createPaletteModel()
    const tokens = uniform(BLUE)
    tokens.set('--ui-bg', 'color-mix(in oklab, red, blue)')
    tokens.delete('--ui-text-muted')
    expect(model.setTarget(tokens)).toEqual(['--ui-bg', '--ui-text-muted'])
    expect(model.moving).toBe(false)
    expect(lab(model.palette, PaletteSlot.accent)).toEqual(settledLab(BLUE))
  })

  it('keeps a slot on its last target when a later read fails to parse', () => {
    const model = createPaletteModel()
    model.setTarget(uniform(BLUE))
    const tokens = uniform(RED)
    tokens.set('--ui-bg', '')
    model.setTarget(tokens)
    run(model, 2)
    expect(lab(model.palette, PaletteSlot.bg)).toEqual(settledLab(BLUE))
    expect(lab(model.palette, PaletteSlot.accent)).toEqual(settledLab(RED))
  })
})

describe('the palette lerp', () => {
  it('starts exactly at the old colour and settles exactly on the new one', () => {
    const model = createPaletteModel()
    model.setTarget(uniform(BLUE))
    const from = lab(model.palette, 0)
    model.setTarget(uniform(YELLOW))
    expect(lab(model.palette, 0)).toEqual(from) // nothing moves before a frame

    const to = settledLab(YELLOW)
    const span = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    let distanceAtLerpEnd = NaN
    run(model, PALETTE_LERP_SEC, () => {
      const now = lab(model.palette, 0)
      distanceAtLerpEnd = Math.hypot(now[0] - to[0], now[1] - to[1], now[2] - to[2])
    })
    expect(distanceAtLerpEnd / span).toBeLessThan(0.015)
    run(model, 1)
    expect(model.moving).toBe(false)
    expect(lab(model.palette, 0)).toEqual(to)
    expect(model.palette.css[0]).toBe('rgb(250 204 21)')
  })

  it('travels the straight OKLab line, so the midpoint is the OKLab midpoint', () => {
    const model = createPaletteModel()
    model.setTarget(uniform(BLUE))
    const from = lab(model.palette, 0)
    const fromLinear = Array.from(model.palette.linear.subarray(0, 3))
    model.setTarget(uniform(YELLOW))
    const to = settledLab(YELLOW)
    const toModel = createPaletteModel()
    toModel.setTarget(uniform(YELLOW))
    const toLinear = Array.from(toModel.palette.linear.subarray(0, 3))

    let mid: { s: number; linear: number[] } | null = null
    run(model, PALETTE_LERP_SEC, () => {
      const now = lab(model.palette, 0)
      const s = (now[0] - from[0]) / (to[0] - from[0])
      // a and b have made the same fraction of their journey as L.
      expect(now[1]).toBeCloseTo(from[1] + s * (to[1] - from[1]), 4)
      expect(now[2]).toBeCloseTo(from[2] + s * (to[2] - from[2]), 4)
      if (!mid || Math.abs(s - 0.5) < Math.abs(mid.s - 0.5)) {
        mid = { s, linear: Array.from(model.palette.linear.subarray(0, 3)) }
      }
    })
    const found = mid as { s: number; linear: number[] } | null
    if (!found) throw new Error('no frames')
    expect(Math.abs(found.s - 0.5)).toBeLessThan(0.1)

    // The colour there is the OKLab interpolation at that fraction…
    const s = found.s
    const expected = new Float64Array(3)
    oklabToLinearRgbInto(
      from[0] + s * (to[0] - from[0]),
      from[1] + s * (to[1] - from[1]),
      from[2] + s * (to[2] - from[2]),
      expected,
      0
    )
    let fromRgbLerp = 0
    for (let c = 0; c < 3; c++) {
      const clamped = Math.min(1, Math.max(0, expected[c] ?? NaN))
      expect(found.linear[c]).toBeCloseTo(clamped, 5)
      const rgbLerp = (fromLinear[c] ?? 0) + s * ((toLinear[c] ?? 0) - (fromLinear[c] ?? 0))
      fromRgbLerp = Math.max(fromRgbLerp, Math.abs((found.linear[c] ?? 0) - rgbLerp))
    }
    // …and measurably not the linear-RGB one, so the test can tell the two apart.
    expect(fromRgbLerp).toBeGreaterThan(0.05)
  })

  it('starts gently: the first frame of a change moves a small part of the way', () => {
    const model = createPaletteModel()
    model.setTarget(uniform('#000000'))
    model.setTarget(uniform('#ffffff'))
    model.update(FRAME)
    expect(lab(model.palette, 0)[0]).toBeLessThan(0.02)
  })

  it('follows the same path at 30 fps as at 60', () => {
    const at60 = createPaletteModel()
    const at30 = createPaletteModel()
    for (const m of [at60, at30]) {
      m.setTarget(uniform(BLUE))
      m.setTarget(uniform(YELLOW))
    }
    for (let f = 0; f < 18; f++) at60.update(1 / 60)
    for (let f = 0; f < 9; f++) at30.update(1 / 30)
    const a = lab(at60.palette, 0)
    const b = lab(at30.palette, 0)
    for (let c = 0; c < 3; c++) expect(a[c]).toBeCloseTo(b[c] ?? NaN, 5)
  })

  it('retargets mid-lerp without a jump or a kink', () => {
    const model = createPaletteModel()
    model.setTarget(uniform(BLUE))
    model.setTarget(uniform(YELLOW))
    const trace: [number, number, number][] = []
    const record = (): void => {
      trace.push(lab(model.palette, 0))
    }
    run(model, 0.2, record)
    model.setTarget(uniform(RED))
    run(model, 1.5, record)

    const step = (i: number): [number, number, number] => {
      const a = trace[i - 1] as [number, number, number]
      const b = trace[i] as [number, number, number]
      return [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    }
    let largestStep = 0
    let largestKink = 0
    for (let i = 2; i < trace.length; i++) {
      const now = step(i)
      const before = step(i - 1)
      largestStep = Math.max(largestStep, Math.hypot(...now))
      largestKink = Math.max(
        largestKink,
        Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2])
      )
    }
    // Continuous (no frame moves more than a small slice of the journey) and
    // smooth (the per-frame step changes gradually, retarget frame included).
    const [y, r] = [settledLab(YELLOW), settledLab(RED)]
    const span = Math.hypot(y[0] - r[0], y[1] - r[1], y[2] - r[2])
    expect(largestStep / span).toBeLessThan(0.1)
    // A change from rest accelerates by ω²·dt² ≈ 3.4 % of its span in the first
    // frame; a retarget may be no harsher than that.
    const fromRest = (6.64 / PALETTE_LERP_SEC) ** 2 * FRAME ** 2
    expect(largestKink / span).toBeLessThan(fromRest * 1.25)
    expect(model.moving).toBe(false)
    expect(trace[trace.length - 1]).toEqual(settledLab(RED))
  })

  it('follows a stream of small targets (the reactive-accent fade) without stepping', () => {
    const model = createPaletteModel()
    model.setTarget(uniform(BLUE))
    const from = settledLab(BLUE)
    const to = settledLab(RED)
    let last = lab(model.palette, 0)
    let largestStep = 0
    // 320 ms of targets that each move a frame's worth, then a settle.
    for (let f = 1; f <= 120; f++) {
      const s = Math.min(1, (f * FRAME) / 0.32)
      const l = from[0] + s * (to[0] - from[0])
      const a = from[1] + s * (to[1] - from[1])
      const b = from[2] + s * (to[2] - from[2])
      const c = Math.hypot(a, b)
      const h = (Math.atan2(b, a) * 180) / Math.PI
      if (s < 1 || f === 20) model.setTarget(uniform(`oklch(${l * 100}% ${c} ${h})`))
      model.update(FRAME)
      const now = lab(model.palette, 0)
      largestStep = Math.max(
        largestStep,
        Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2])
      )
      last = now
    }
    expect(largestStep).toBeLessThan(0.03)
    const end = lab(model.palette, 0)
    for (let c = 0; c < 3; c++) expect(end[c]).toBeCloseTo(to[c] ?? NaN, 3)
  })

  it('does nothing at rest — same strings, same version', () => {
    const model = createPaletteModel()
    model.setTarget(uniform(BLUE))
    const css = model.palette.css[0]
    const version = model.palette.version
    run(model, 1)
    expect(model.palette.css[0]).toBe(css)
    expect(model.palette.version).toBe(version)
  })
})

describe('High Contrast', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`resolves its ${mode} ramp with no NaN and nothing out of gamut, mid-lerp included`, () => {
      const model = createPaletteModel()
      expect(model.setTarget(themeTokens(HIGH_CONTRAST_THEME_ID, mode))).toEqual([])
      const check = (): void => {
        for (const value of model.palette.linear) {
          expect(Number.isFinite(value)).toBe(true)
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(1)
        }
        for (const value of model.palette.oklab) expect(Number.isFinite(value)).toBe(true)
        for (const css of model.palette.css) expect(css).toMatch(/^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/)
      }
      check()
      // …and on the way to and from the other built-in themes.
      for (const other of BUILT_IN_THEMES) {
        model.setTarget(themeTokens(other.id, mode === 'light' ? 'dark' : 'light'))
        run(model, 0.3, check)
        model.setTarget(themeTokens(HIGH_CONTRAST_THEME_ID, mode))
        run(model, 1, check)
      }
    })
  }
})
