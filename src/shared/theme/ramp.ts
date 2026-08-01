/**
 * Colour ramps, and the three ways T5a lets one be authored.
 *
 * A colour role — primary, error, neutral — is an eleven-step ramp, because
 * that is what Nuxt UI's semantic variables consume. Asking an operator to
 * choose eleven colours to change the accent would be absurd, so the default
 * authoring mode is one seed and a derived ramp; the other two modes exist for
 * the operator who wants Tailwind's exact `violet`, or who wants to place all
 * eleven steps by hand.
 *
 * Whichever mode, the output is the same shape. Nothing downstream — the
 * bridge, the contrast checker, the editor's swatches — knows or cares which
 * mode produced the ramp it is looking at.
 */

import { clampToGamut, formatOklch, oklch, parseColor } from './color'
import {
  RAMP_CHROMA_SCALE,
  RAMP_LIGHTNESS,
  RAMP_NEUTRAL_LIGHTNESS,
  TAILWIND_PALETTES
} from './palettes'

export const RAMP_STEPS = [
  '50',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '950'
] as const

export type RampStep = (typeof RAMP_STEPS)[number]
export type RampSteps = Readonly<Record<RampStep, string>>

/**
 * The step a seed is taken to *be*. 500 is the conventional "this is the
 * colour" step across Tailwind and every palette that copies it, so an operator
 * pasting a brand colour gets that colour at 500 rather than a ramp that merely
 * passes near it.
 */
export const SEED_STEP: RampStep = '500'

export type RampSpec =
  | { readonly mode: 'palette'; readonly palette: string }
  | { readonly mode: 'seed'; readonly seed: string }
  | { readonly mode: 'custom'; readonly steps: RampSteps }

/**
 * The chroma below which a seed is treated as a grey and walks the neutral
 * ladder instead of the chromatic one.
 *
 * Set at the same threshold the generator uses to split Tailwind's own families,
 * so "which ladder does this seed walk" is answered the same way on both sides.
 * A tinted grey — a neutral shifted a few degrees towards blue — is still a
 * grey, and wants the grey ladder.
 */
const NEUTRAL_CHROMA_MAX = 0.05

/**
 * Build a ramp from one colour.
 *
 * Hue is held fixed and lightness walks an averaged Tailwind ladder, with
 * chroma scaled by that ladder's own curve so the result carries the most
 * colour where a real palette does. Steps that leave sRGB give up chroma rather
 * than lightness — see `clampToGamut` — which keeps the ladder monotonic in the
 * one dimension the ramp exists to express.
 *
 * The seed's own lightness is deliberately discarded. A ramp seeded with a very
 * pale colour that honoured it would have no dark end, and every surface built
 * on that role would be unreadable; taking hue and chroma and re-walking the
 * ladder is what makes "paste any colour" a safe offer.
 *
 * Which ladder it walks is chosen by the seed's chroma, because Tailwind's greys
 * sit markedly darker through the middle than its colours do. Getting this wrong
 * is not cosmetic: the neutral ramp is where every surface and text weight comes
 * from, so a grey on the chromatic ladder produces body text that cannot reach
 * 4.5:1 against its own background.
 */
export function rampFromSeed(seed: string): RampSteps | null {
  const parsed = parseColor(seed)
  if (!parsed) return null

  const ladder = parsed.c <= NEUTRAL_CHROMA_MAX ? RAMP_NEUTRAL_LIGHTNESS : RAMP_LIGHTNESS

  const steps: Partial<Record<RampStep, string>> = {}
  for (const step of RAMP_STEPS) {
    const derived = oklch(ladder[step], parsed.c * RAMP_CHROMA_SCALE[step], parsed.h, parsed.alpha)
    steps[step] = formatOklch(clampToGamut(derived))
  }
  return steps as RampSteps
}

/** True when `name` is a Tailwind ramp the operator may select. */
export function isTailwindPalette(name: string): boolean {
  return Object.hasOwn(TAILWIND_PALETTES, name)
}

/**
 * Resolve a spec to eleven values, or null when it cannot be resolved — an
 * unparseable seed, or a palette name that is not Tailwind's.
 *
 * Null rather than a fallback ramp on purpose. A malformed override that
 * silently resolved to some default would leave the operator staring at a
 * colour they did not choose with nothing on screen explaining why; the caller
 * gets the null and says so.
 */
export function resolveRamp(spec: RampSpec): RampSteps | null {
  switch (spec.mode) {
    case 'palette':
      return TAILWIND_PALETTES[spec.palette] ?? null
    case 'seed':
      return rampFromSeed(spec.seed)
    case 'custom':
      return RAMP_STEPS.every((step) => parseColor(spec.steps[step]) !== null) ? spec.steps : null
  }
}

/**
 * Read a spec back out of a resolved ramp, so the editor can open on the mode
 * the operator last used rather than always on `custom`.
 *
 * An exact match against a Tailwind ramp reports `palette`; a ramp that matches
 * what its own 500 would derive reports `seed`. Both comparisons are on the
 * canonical `oklch()` string, which is why `formatOklch` exists — comparing
 * colours structurally would make two spellings of the same colour a mismatch.
 */
export function describeRamp(steps: RampSteps): RampSpec {
  for (const [name, palette] of Object.entries(TAILWIND_PALETTES)) {
    if (RAMP_STEPS.every((step) => palette[step] === steps[step])) {
      return { mode: 'palette', palette: name }
    }
  }

  const seed = steps[SEED_STEP]
  const derived = rampFromSeed(seed)
  if (derived && RAMP_STEPS.every((step) => derived[step] === steps[step])) {
    return { mode: 'seed', seed }
  }

  return { mode: 'custom', steps }
}
