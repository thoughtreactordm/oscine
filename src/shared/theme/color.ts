/**
 * Colour parsing and conversion for the token layer.
 *
 * OKLCH is the working space, not a preference. Deriving a ramp means holding a
 * hue steady while lightness walks a ladder, and in sRGB or HSL that walk shifts
 * the perceived hue — a mid-blue lightened in HSL arrives noticeably purple.
 * OKLCH is perceptually uniform enough that the ladder stays on the hue it
 * started on, which is the whole reason T5a can offer "one seed colour, ramp
 * derived" as a mode an operator would actually accept the output of.
 *
 * Everything here is pure and dependency-free so it runs under plain Node in
 * `tests/`, the same rule `listViewport` and the settings kernel follow.
 */

/** A colour in OKLCH, the form themes and overrides are stored in. */
export interface Oklch {
  /** Perceptual lightness, 0–1. */
  readonly l: number
  /** Chroma. Unbounded in principle; ~0.37 is the most sRGB can hold. */
  readonly c: number
  /** Hue angle in degrees, 0–360. */
  readonly h: number
  /** 0–1. */
  readonly alpha: number
}

/** Linear-light sRGB, 0–1 per channel and *not* gamma encoded. */
interface LinearRgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

const CLAMP_EPSILON = 1e-6

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Hue is the one component where clamping would be wrong — it is an angle, so
 * 380° is 20° rather than an error, and a ramp that wrapped past 360 would
 * otherwise flatten onto red.
 */
function normaliseHue(deg: number): number {
  const wrapped = deg % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

export function oklch(l: number, c: number, h: number, alpha = 1): Oklch {
  return {
    l: clamp(l, 0, 1),
    c: Math.max(0, c),
    h: normaliseHue(h),
    alpha: clamp(alpha, 0, 1)
  }
}

/* -------------------------------------------------------------------------- */
/* OKLCH <-> linear sRGB                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ottosson's OKLab matrices. The cube root / cube pair between LMS and L'M'S'
 * is what makes the space perceptual; without it this is just another linear
 * transform and the hue drift comes back.
 */
function oklchToLinearRgb({ l, c, h }: Oklch): LinearRgb {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)

  const lp = l + 0.3963377774 * a + 0.2158037573 * b
  const mp = l - 0.1055613458 * a - 0.0638541728 * b
  const sp = l - 0.0894841775 * a - 1.291485548 * b

  const lc = lp * lp * lp
  const mc = mp * mp * mp
  const sc = sp * sp * sp

  return {
    r: 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    g: -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    b: -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc
  }
}

function linearRgbToOklch({ r, g, b }: LinearRgb, alpha: number): Oklch {
  const lc = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mc = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const sc = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const l = 0.2104542553 * lc + 0.793617785 * mc - 0.0040720468 * sc
  const a = 1.9779984951 * lc - 2.428592205 * mc + 0.4505937099 * sc
  const bb = 0.0259040371 * lc + 0.7827717662 * mc - 0.808675766 * sc

  const chroma = Math.hypot(a, bb)
  // Below a hair of chroma the hue angle is numerical noise — atan2 on two
  // near-zero components. Report 0 rather than a random direction, so a grey
  // round-trips to the same grey instead of acquiring a tint.
  const hue = chroma < CLAMP_EPSILON ? 0 : (Math.atan2(bb, a) * 180) / Math.PI

  return oklch(l, chroma, hue, alpha)
}

/* -------------------------------------------------------------------------- */
/* Gamma                                                                       */
/* -------------------------------------------------------------------------- */

function gammaEncode(channel: number): number {
  const v = clamp(channel, 0, 1)
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

function gammaDecode(channel: number): number {
  const v = clamp(channel, 0, 1)
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const HEX_PATTERN = /^#([0-9a-f]{3,8})$/i
const OKLCH_PATTERN = /^oklch\(\s*([^)]+)\)$/i
const RGB_PATTERN = /^rgba?\(\s*([^)]+)\)$/i

/**
 * A number that may carry a unit we accept. `percent` says what a bare `%`
 * means for this component, since OKLCH lightness is `0%–100%` but chroma is
 * `0%–0.4` — the same glyph, two scales.
 */
function parseComponent(raw: string, percentOf: number): number | null {
  const text = raw.trim()
  if (text === 'none') return 0
  const isPercent = text.endsWith('%')
  const value = Number.parseFloat(isPercent ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) return null
  return isPercent ? (value / 100) * percentOf : value
}

function parseHex(digits: string): Oklch | null {
  const expand = (pair: string): number => Number.parseInt(pair, 16) / 255

  let channels: string[]
  if (digits.length === 3 || digits.length === 4) {
    channels = [...digits].map((d) => d + d)
  } else if (digits.length === 6 || digits.length === 8) {
    channels = digits.match(/.{2}/g) ?? []
  } else {
    return null
  }

  const [r, g, b, a] = channels.map(expand)
  if (r === undefined || g === undefined || b === undefined) return null

  return linearRgbToOklch({ r: gammaDecode(r), g: gammaDecode(g), b: gammaDecode(b) }, a ?? 1)
}

/**
 * Parse a CSS colour the operator may have typed, or a theme may have declared,
 * into OKLCH.
 *
 * Deliberately narrow: hex, `rgb()`/`rgba()` and `oklch()`. Named colours and
 * the wider colour-function surface are absent because every format accepted
 * here is one the contrast checker must also understand — a value it cannot
 * parse is a value whose legibility it silently cannot vouch for, and T7 says
 * contrast must not be *silently* destroyable. Returns null rather than
 * throwing; the caller decides whether that is a warning or a rejection.
 */
export function parseColor(input: string): Oklch | null {
  const text = input.trim()

  const hex = HEX_PATTERN.exec(text)
  if (hex?.[1]) return parseHex(hex[1])

  const ok = OKLCH_PATTERN.exec(text)
  if (ok?.[1]) {
    const [coords = '', alphaPart] = ok[1].split('/')
    const parts = coords.trim().split(/\s+/)
    if (parts.length < 3) return null
    const l = parseComponent(parts[0] ?? '', 1)
    const c = parseComponent(parts[1] ?? '', 0.4)
    const h = parseComponent(parts[2] ?? '', 360)
    const alpha = alphaPart === undefined ? 1 : parseComponent(alphaPart, 1)
    if (l === null || c === null || h === null || alpha === null) return null
    return oklch(l, c, h, alpha)
  }

  const rgb = RGB_PATTERN.exec(text)
  if (rgb?.[1]) {
    const [coords = '', slashAlpha] = rgb[1].split('/')
    const parts = coords
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map((p) => parseComponent(p, 255))
    if (channels.some((v) => v === null)) return null
    const [r, g, b] = channels as number[]
    const alphaText = slashAlpha ?? parts[3]
    const alpha = alphaText === undefined ? 1 : parseComponent(alphaText, 1)
    if (alpha === null || r === undefined || g === undefined || b === undefined) return null
    return linearRgbToOklch(
      {
        r: gammaDecode(r / 255),
        g: gammaDecode(g / 255),
        b: gammaDecode(b / 255)
      },
      alpha
    )
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function trim(value: number, places: number): string {
  return Number.parseFloat(value.toFixed(places)).toString()
}

/**
 * Themes and overrides serialise as `oklch()` regardless of what was typed.
 * One canonical form means the editor's "is this overridden" comparison is a
 * string compare rather than a colour compare, and it keeps an authored theme
 * readable as the ramp it is.
 */
export function formatOklch(color: Oklch): string {
  const base = `oklch(${trim(color.l * 100, 2)}% ${trim(color.c, 4)} ${trim(color.h, 2)}`
  return color.alpha >= 1 ? `${base})` : `${base} / ${trim(color.alpha, 3)})`
}

/** Gamma-encoded sRGB, for the places that need a hex — window backgroundColor. */
export function toHex(color: Oklch): string {
  const linear = oklchToLinearRgb(color)
  const channel = (v: number): string =>
    Math.round(gammaEncode(v) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(linear.r)}${channel(linear.g)}${channel(linear.b)}`
}

/**
 * True when the colour lies outside what sRGB can show. A derived ramp step can
 * land here when a seed carries more chroma than sRGB holds at that lightness,
 * and the honest response is to say so rather than to let the browser clip it
 * into a flat, off-hue block.
 */
export function isOutOfGamut(color: Oklch): boolean {
  const { r, g, b } = oklchToLinearRgb(color)
  const low = -CLAMP_EPSILON
  const high = 1 + CLAMP_EPSILON
  return r < low || r > high || g < low || g > high || b < low || b > high
}

/**
 * Pull a colour back into sRGB by giving up chroma and keeping lightness and
 * hue, which is the trade that preserves what the ramp step was *for*: its
 * position on the lightness ladder. Clipping RGB instead would move both.
 */
export function clampToGamut(color: Oklch): Oklch {
  if (!isOutOfGamut(color)) return color

  let low = 0
  let high = color.c
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2
    if (isOutOfGamut(oklch(color.l, mid, color.h, color.alpha))) high = mid
    else low = mid
  }
  return oklch(color.l, low, color.h, color.alpha)
}

/* -------------------------------------------------------------------------- */
/* WCAG luminance                                                              */
/* -------------------------------------------------------------------------- */

/**
 * WCAG 2.1 relative luminance.
 *
 * Note this reads the *linear* channels straight out of the OKLab conversion:
 * the spec defines luminance over linear-light sRGB, and going via a gamma
 * encode only to decode it again would round-trip through 8-bit for nothing.
 * Channels are clamped, so an out-of-gamut colour is measured as the colour a
 * display would actually show.
 */
export function relativeLuminance(color: Oklch): number {
  const { r, g, b } = oklchToLinearRgb(color)
  return 0.2126 * clamp(r, 0, 1) + 0.7152 * clamp(g, 0, 1) + 0.0722 * clamp(b, 0, 1)
}
