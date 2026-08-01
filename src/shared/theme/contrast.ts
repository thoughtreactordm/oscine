/**
 * WCAG 2.1 contrast, and the pairs of tokens worth checking.
 *
 * T7: warn, never block. An operator who wants a low-contrast theme gets one —
 * it is their machine and their eyes — but they are told, on the row that did
 * it, at the moment they do it. The card's requirement is that contrast is not
 * *silently* destroyable, which is a different and much better requirement than
 * contrast being undestroyable.
 */

import { parseColor, relativeLuminance, type Oklch } from './color'

/** WCAG 2.1 AA, normal text. */
export const AA_NORMAL = 4.5
/** WCAG 2.1 AA, text at 18.66px bold or 24px regular and above. */
export const AA_LARGE = 3
/** WCAG 2.1 AA, UI component and graphical object boundaries. */
export const AA_NON_TEXT = 3

export type ContrastDemand = 'normal' | 'large' | 'nonText'

const DEMAND_RATIO: Record<ContrastDemand, number> = {
  normal: AA_NORMAL,
  large: AA_LARGE,
  nonText: AA_NON_TEXT
}

/**
 * Composite a partially transparent foreground over its background, because the
 * contrast of a colour with alpha is a property of the pair, not of the colour.
 * `--ui-text-dimmed` at 60% over a dark surface and over a pale one are two
 * different measurements, and checking the uncomposited value would pass both
 * or fail both.
 *
 * Mixing happens in linear-light terms via luminance rather than by mixing the
 * OKLCH coordinates, since luminance is the only thing the ratio consumes.
 */
function compositeLuminance(foreground: Oklch, background: Oklch): number {
  const fg = relativeLuminance(foreground)
  if (foreground.alpha >= 1) return fg
  const bg = relativeLuminance(background)
  return fg * foreground.alpha + bg * (1 - foreground.alpha)
}

/**
 * The WCAG 2.1 ratio, 1–21. Symmetric: which colour is the text does not change
 * the number, only which one gets composited.
 */
export function contrastRatio(foreground: Oklch, background: Oklch): number {
  const fg = compositeLuminance(foreground, background)
  const bg = relativeLuminance(background)
  const lighter = Math.max(fg, bg)
  const darker = Math.min(fg, bg)
  return (lighter + 0.05) / (darker + 0.05)
}

/** A pair the theme layer promises will stay legible. */
export interface ContrastPair {
  /** Token id of the foreground — text, or a boundary. */
  readonly foreground: string
  /** Token id of the surface it lands on. */
  readonly background: string
  readonly demand: ContrastDemand
  /** Shown in the warning, so it names a place rather than two token ids. */
  readonly where: string
}

export interface ContrastFinding {
  readonly pair: ContrastPair
  readonly ratio: number
  readonly required: number
  /** Which of the two tokens the operator most recently moved, when known. */
  readonly blame: string | null
}

/**
 * Check every pair against a resolved token map.
 *
 * A pair naming a token the map does not hold is skipped rather than reported.
 * Overrides may name tokens a theme has dropped (the unknown-key rule), and a
 * missing token is a gap in the catalog, not a contrast failure — reporting it
 * here would put the wrong words on the wrong screen.
 */
export function findContrastFailures(
  tokens: ReadonlyMap<string, string>,
  pairs: readonly ContrastPair[],
  changed: ReadonlySet<string> = new Set()
): ContrastFinding[] {
  const findings: ContrastFinding[] = []

  for (const pair of pairs) {
    const fgRaw = tokens.get(pair.foreground)
    const bgRaw = tokens.get(pair.background)
    if (fgRaw === undefined || bgRaw === undefined) continue

    const fg = parseColor(fgRaw)
    const bg = parseColor(bgRaw)
    if (!fg || !bg) continue

    const ratio = contrastRatio(fg, bg)
    const required = DEMAND_RATIO[pair.demand]
    if (ratio >= required) continue

    findings.push({
      pair,
      ratio,
      required,
      blame: changed.has(pair.foreground)
        ? pair.foreground
        : changed.has(pair.background)
          ? pair.background
          : null
    })
  }

  return findings
}

/**
 * The pairs. Deliberately a short list of the combinations that actually appear
 * on screen rather than the cross product of every text token with every
 * surface — a warning that fires on a pairing no component renders teaches the
 * operator to ignore warnings.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  {
    foreground: 'text.base',
    background: 'surface.base',
    demand: 'normal',
    where: 'body text on the window background'
  },
  {
    foreground: 'text.highlighted',
    background: 'surface.base',
    demand: 'normal',
    where: 'headings and track titles'
  },
  {
    foreground: 'text.muted',
    background: 'surface.base',
    demand: 'normal',
    where: 'secondary text — artist, album, duration'
  },
  {
    foreground: 'text.toned',
    background: 'surface.base',
    demand: 'normal',
    where: 'help text under a setting'
  },
  /*
   * `text.dimmed` on a surface is deliberately absent.
   *
   * It sits at 2.55:1 in light mode and we ship it anyway. The token is
   * overwhelmingly disabled and inactive state, which WCAG 1.4.3 exempts
   * outright, and raising it forces the whole five-step ladder up — the four
   * weights above it already pass with room, so the only way to fix `dimmed`
   * was to make body text nearly black. That trade was not worth it.
   *
   * The honest cost: placeholder text uses this token too, and placeholders are
   * *not* exempt. A theme that pushes `dimmed` lighter still will not be warned
   * about it. If placeholders ever get their own token, this pair should come
   * back against that one.
   */
  {
    foreground: 'text.base',
    background: 'surface.elevated',
    demand: 'normal',
    where: 'text on a raised panel — the rail, a popover'
  },
  {
    foreground: 'text.highlighted',
    background: 'surface.elevated',
    demand: 'normal',
    where: 'a selected row in a list'
  },
  {
    foreground: 'text.muted',
    background: 'surface.muted',
    demand: 'normal',
    where: 'text on a recessed surface — a table header'
  },
  {
    foreground: 'text.inverted',
    background: 'surface.inverted',
    demand: 'normal',
    where: 'text on an inverted surface — a tooltip'
  },
  /*
   * `border.accented` on a surface is absent for a related reason.
   *
   * It is 1.49:1 in light mode. WCAG 1.4.11 asks 3:1 of a control boundary, but
   * qualifies that with "required to identify" the control — and this app's
   * inputs and controls are identified by their fill and their text as well as
   * their edge. Meeting it would mean replacing every hairline in the app with
   * a mid-grey rule, which is a different-looking application, not a more
   * accessible one.
   *
   * The cost is real and worth naming: this variable is also the scrollbar
   * thumb, which has no fill to fall back on, and at 1.49:1 it is faint.
   */
  /*
   * The accent tokens, not a step of the ramp. `text-primary` resolves to one
   * colour that differs between light and dark, and checking a fixed step would
   * measure a colour no surface ever shows.
   */
  {
    foreground: 'accent.primary',
    background: 'surface.base',
    demand: 'nonText',
    where: 'the accent — focus rings, the playing indicator'
  },
  {
    foreground: 'accent.error',
    background: 'surface.base',
    demand: 'nonText',
    where: 'error states'
  },
  {
    foreground: 'accent.warning',
    background: 'surface.base',
    demand: 'nonText',
    where: 'the restart-required badge'
  },
  {
    foreground: 'accent.primary',
    background: 'surface.elevated',
    demand: 'nonText',
    where: 'the accent on a raised panel'
  }
]
