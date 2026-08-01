/**
 * Generates `src/shared/theme/palettes.ts` from the installed Tailwind theme.
 *
 * The token layer needs Tailwind's ramps as *data*, not as CSS. T5a lets an
 * operator name a Tailwind palette for a colour role, and the resolved values
 * have to be readable in JS — to write them into `--ui-color-<role>-<step>`, to
 * measure contrast against them, and to show them as swatches in the editor.
 *
 * Referencing `var(--color-red-500)` instead would be smaller and wrong:
 * Tailwind v4 tree-shakes theme variables no utility mentions, so a palette
 * nothing in `src/` names would resolve to nothing at runtime — and the whole
 * point is that the operator picks one we did not anticipate.
 *
 * Regenerate after a Tailwind upgrade:
 *
 *     npm run palettes
 *
 * Change Tailwind's version, not the generated file.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const themeCss = join(dirname(require.resolve('tailwindcss/package.json')), 'theme.css')
const css = readFileSync(themeCss, 'utf8')

const version = JSON.parse(
  readFileSync(join(dirname(require.resolve('tailwindcss/package.json')), 'package.json'), 'utf8')
).version

/**
 * Only the eleven-step colour ramps. `theme.css` also carries `--color-black`,
 * `--color-white` and the non-colour scales, none of which are a ramp an
 * operator can assign to a role.
 */
const palettes = {}
const pattern = /--color-([a-z]+)-(\d{2,3}):\s*([^;]+);/g
for (const [, name, step, value] of css.matchAll(pattern)) {
  ;(palettes[name] ??= {})[step] = value.trim()
}

const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']

const names = Object.keys(palettes).sort()
const complete = names.filter((name) => STEPS.every((step) => palettes[name][step]))
const partial = names.filter((name) => !complete.includes(name))
if (partial.length > 0) {
  throw new Error(`Palettes missing steps, refusing to emit a half ramp: ${partial.join(', ')}`)
}

const body = complete
  .map((name) => {
    const steps = STEPS.map((step) => `    '${step}': '${palettes[name][step]}'`).join(',\n')
    return `  ${name}: {\n${steps}\n  }`
  })
  .join(',\n')

/*
 * The shape of a Tailwind ramp, averaged, so a seed-derived ramp lands
 * somewhere an eye trained on Tailwind reads as normal.
 *
 * Only the chromatic palettes contribute. The neutrals sit on a different
 * lightness ladder — `neutral-500` is 55.6% where `red-500` is 63.7% — and
 * averaging the two families produces a ladder that matches neither.
 */
// Hue is `none` on the pure greys — an achromatic colour has no hue angle to
// state — so only lightness and chroma are read here, which is all the ladder
// needs anyway.
const OKLCH_COORDS = /oklch\(\s*([\d.]+)%\s+([\d.]+)\s/
const coords = (value) => {
  const m = OKLCH_COORDS.exec(value)
  if (!m) throw new Error(`Palette entry is not plain oklch(): ${value}`)
  return { l: Number(m[1]) / 100, c: Number(m[2]) }
}

const chromatic = complete.filter((name) => coords(palettes[name]['500']).c > 0.05)
const neutrals = complete.filter((name) => coords(palettes[name]['500']).c <= 0.05)
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length
const round = (value, places) => Number(value.toFixed(places))

const lightnessOf = (family) =>
  STEPS.map((step) => round(mean(family.map((n) => coords(palettes[n][step]).l)), 4))

const lightness = lightnessOf(chromatic)
const neutralLightness = lightnessOf(neutrals)
const chromaScale = STEPS.map((step) =>
  round(mean(chromatic.map((n) => coords(palettes[n][step]).c / coords(palettes[n]['500']).c)), 4)
)

const ladder = (label, values) =>
  STEPS.map((step, i) => `  '${step}': ${values[i]}`).join(',\n') || label

const out = `/**
 * Tailwind's colour ramps as data. GENERATED — do not edit.
 *
 * Written by \`scripts/make-palettes.mjs\` from tailwindcss ${version}. Change
 * Tailwind's version and re-run \`npm run palettes\`; editing this file by hand
 * makes it a second source of truth for colours nobody chose.
 */

import type { RampStep, RampSteps } from './ramp'

/** The ${complete.length} named ramps an operator can assign to a colour role. */
export const TAILWIND_PALETTES: Readonly<Record<string, RampSteps>> = {
${body}
}

export const TAILWIND_PALETTE_NAMES: readonly string[] = Object.keys(TAILWIND_PALETTES)

/**
 * Mean lightness per step across the ${chromatic.length} chromatic Tailwind ramps.
 * A seed-derived ramp walks this ladder so it reads as a sibling of the built-in
 * palettes rather than as an evenly-spaced gradient, which no real ramp is.
 */
export const RAMP_LIGHTNESS: Readonly<Record<RampStep, number>> = {
${ladder('lightness', lightness)}
}

/**
 * The same, across the ${neutrals.length} achromatic ramps — and a genuinely
 * different ladder: \`neutral-500\` sits at ${neutralLightness[5]} where the chromatic
 * mean is ${lightness[5]}.
 *
 * A grey seeded onto the chromatic ladder comes out far too light in the middle,
 * and since every surface and text weight is a step of the neutral ramp, the
 * result is body text that cannot reach 4.5:1 against its own background. Which
 * ladder a seed walks is therefore a correctness question, not a nicety.
 */
export const RAMP_NEUTRAL_LIGHTNESS: Readonly<Record<RampStep, number>> = {
${ladder('lightness', neutralLightness)}
}

/**
 * Mean chroma per step, expressed as a multiple of the ramp's own 500. Chroma
 * falls away towards both ends and holds nearly flat across 500–600, because
 * very light and very dark colours alike run out of gamut to be saturated in.
 * That is why the seed is pinned at 500: it is where a ramp carries the most
 * chroma, so it is where the colour the operator pasted survives intact.
 */
export const RAMP_CHROMA_SCALE: Readonly<Record<RampStep, number>> = {
${ladder('chroma', chromaScale)}
}
`

writeFileSync(join(root, 'src/shared/theme/palettes.ts'), out)
console.log(`palettes: ${complete.length} ramps from tailwindcss ${version}`)
