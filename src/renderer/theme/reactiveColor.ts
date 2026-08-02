/**
 * Reading an accent out of the cover.
 *
 * DOM-free like `themeController.ts`, and for the same reason: `tests/` compiles
 * under `tsconfig.node.json`, which has no DOM lib. This takes the pixels as a
 * plain byte array and hands back a seed; everything that fetches artwork and
 * paints is in `artworkAccent.ts`.
 *
 * The output is a *seed*, not a palette, because `rampFromSeed` already does the
 * hard part. It discards the seed's lightness outright and re-walks the averaged
 * Tailwind ladder, so eleven readable steps come out of any hue we hand it — the
 * thing that would otherwise make "paint the UI from album art" a contrast
 * disaster is already solved one layer down. What is left for us is only to pick
 * a hue and a chroma, and to know when the artwork does not have one to give.
 */

import {
  clampToGamut,
  formatOklch,
  oklch,
  parseColor,
  rampFromSeed,
  SEED_STEP
} from '@shared/theme'

/**
 * The chroma below which a colour is a grey, matching `ramp.ts`'s own
 * `NEUTRAL_CHROMA_MAX`.
 *
 * Deliberately the same number. Below it `rampFromSeed` switches to the neutral
 * lightness ladder, so a seed under this threshold would not produce a dull
 * accent — it would produce a *grey* accent, and the focus ring and the playing
 * indicator would stop being findable. A monochrome cover has no accent in it,
 * and the honest answer is to return null and let the theme's own primary stand.
 */
const MIN_CHROMA = 0.05

/**
 * Near-black and near-white are excluded before anything is scored.
 *
 * Not a nicety: they are the two largest regions on a large fraction of covers —
 * letterboxing, a white sleeve, a black background — and their hue is whatever
 * survived JPEG quantisation rather than a colour anyone chose. Including them
 * means the accent of half the library is decided by compression noise.
 */
const MIN_LIGHTNESS = 0.18
const MAX_LIGHTNESS = 0.92

/** Pixels more transparent than this are not part of the picture. */
const MIN_ALPHA = 128

/** 10° each. Fine enough to separate orange from red, coarse enough to survive a gradient. */
const HUE_BINS = 36

/** Bins either side of a bin that are folded into its score. See `smooth`. */
const SMOOTHING = 1

/**
 * How hard chroma is allowed to beat population.
 *
 * A straight `population × chroma` hands every sepia and every desaturated
 * indie sleeve the same muddy beige, because a washed-out colour covering most
 * of the cover outscores a vivid one covering a tenth of it by more than the
 * chroma gap can close. Damping population by a cube root is what lets the vivid
 * minority win while still keeping a single bright speck — which has a cube root
 * near one — from taking the whole UI hostage.
 */
function score(count: number, chroma: number): number {
  return Math.cbrt(count) * chroma
}

interface HueBin {
  count: number
  /** Circular mean accumulators — hue cannot be averaged arithmetically. */
  sin: number
  cos: number
  chroma: number
}

function emptyBins(): HueBin[] {
  return Array.from({ length: HUE_BINS }, () => ({ count: 0, sin: 0, cos: 0, chroma: 0 }))
}

/** `#rrggbb` for one averaged bucket, which is the only form `parseColor` takes. */
function hex(r: number, g: number, b: number): string {
  const channel = (value: number): string =>
    Math.round(value).toString(16).padStart(2, '0').slice(-2)
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/**
 * Fold a bin together with its neighbours.
 *
 * Two problems, one fix. A gradient walks across several bins and each alone
 * looks minor; and a hue sitting on a bin boundary — red near 0° especially —
 * gets split in half by an accident of where the boundaries fell. Summing a
 * window rather than reading one bin makes the score depend on the colour rather
 * than on where the grid landed. The wrap is why the index arithmetic is
 * modular: bin 35 and bin 0 are neighbours.
 */
function smooth(bins: readonly HueBin[], index: number): HueBin {
  const total: HueBin = { count: 0, sin: 0, cos: 0, chroma: 0 }
  for (let offset = -SMOOTHING; offset <= SMOOTHING; offset += 1) {
    const bin = bins[(index + offset + HUE_BINS) % HUE_BINS]!
    total.count += bin.count
    total.sin += bin.sin
    total.cos += bin.cos
    total.chroma += bin.chroma
  }
  return total
}

/**
 * Pick a seed from RGBA pixel data, or null when the artwork has no accent in it.
 *
 * `pixels` is tightly packed RGBA, as `getImageData` returns it — the caller has
 * already downscaled, so this is a few thousand entries rather than a few
 * million.
 *
 * Colours are bucketed in RGB first, at three bits a channel, and only the ~512
 * bucket averages are converted to OKLCH. Converting per pixel would be the same
 * answer for forty times the work: the bucket grid is far finer than the 10° hue
 * bins the result is actually scored in.
 */
export function pickAccentSeed(pixels: Uint8ClampedArray): string | null {
  const counts = new Uint32Array(512)
  const sums = new Float64Array(512 * 3)

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i]!
    const g = pixels[i + 1]!
    const b = pixels[i + 2]!
    if (pixels[i + 3]! < MIN_ALPHA) continue

    const bucket = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)
    counts[bucket]! += 1
    sums[bucket * 3]! += r
    sums[bucket * 3 + 1]! += g
    sums[bucket * 3 + 2]! += b
  }

  const bins = emptyBins()
  let populated = false

  for (let bucket = 0; bucket < counts.length; bucket += 1) {
    const count = counts[bucket]!
    if (count === 0) continue

    const color = parseColor(
      hex(sums[bucket * 3]! / count, sums[bucket * 3 + 1]! / count, sums[bucket * 3 + 2]! / count)
    )
    if (!color) continue
    if (color.c < MIN_CHROMA) continue
    if (color.l < MIN_LIGHTNESS || color.l > MAX_LIGHTNESS) continue

    const radians = (color.h * Math.PI) / 180
    const bin = bins[Math.min(HUE_BINS - 1, Math.floor((color.h / 360) * HUE_BINS))]!
    bin.count += count
    bin.sin += Math.sin(radians) * count
    bin.cos += Math.cos(radians) * count
    bin.chroma += color.c * count
    populated = true
  }

  if (!populated) return null

  let best: HueBin | null = null
  let bestScore = 0
  for (let index = 0; index < HUE_BINS; index += 1) {
    const window = smooth(bins, index)
    if (window.count === 0) continue
    const value = score(window.count, window.chroma / window.count)
    if (value > bestScore) {
      bestScore = value
      best = window
    }
  }

  if (!best) return null

  const hue = ((Math.atan2(best.sin, best.cos) * 180) / Math.PI + 360) % 360
  const chroma = best.chroma / best.count
  if (chroma < MIN_CHROMA) return null

  /*
   * Emitted as step 500 of the ramp it will produce rather than as the mean
   * colour itself. `SEED_STEP` is the step a seed is taken to *be*, so running
   * the derivation and reading that step back makes the returned string the
   * accent that will actually show — including the gamut clamp — instead of an
   * approximation of it that a constant here would have to be kept in sync with.
   */
  const ramp = rampFromSeed(formatOklch(clampToGamut(oklch(0.68, chroma, hue))))
  return ramp?.[SEED_STEP] ?? null
}

/**
 * Interpolate between two seeds for the crossfade.
 *
 * In OKLCH rather than sRGB, and around the short arc in hue, because the
 * straight-line path between two sRGB colours detours through grey — a fade from
 * blue to orange that desaturates through the middle reads as a glitch rather
 * than as a transition. Returns `to` unchanged if either end will not parse, so
 * a bad value degrades to a cut instead of throwing mid-frame.
 */
export function mixSeeds(from: string, to: string, t: number): string {
  const a = parseColor(from)
  const b = parseColor(to)
  if (!a || !b) return to

  let arc = b.h - a.h
  if (arc > 180) arc -= 360
  if (arc < -180) arc += 360

  return formatOklch(
    clampToGamut(
      oklch(
        a.l + (b.l - a.l) * t,
        a.c + (b.c - a.c) * t,
        (a.h + arc * t + 360) % 360,
        a.alpha + (b.alpha - a.alpha) * t
      )
    )
  )
}
