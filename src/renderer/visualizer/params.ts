import type { VisualizerParamValues } from '@shared/settings'

/**
 * An effect's knobs — a few broad controls per effect, each scaling a group of
 * its internal constants together, edited from the stage's tuning popover and
 * kept per effect in `interface.visualizerParams`.
 *
 * Every knob is a number in `[min, max]` whose default reproduces the effect's
 * untuned look, so an operator who never opens the popover sees exactly what
 * they saw before knobs existed. Knobs are live: an effect reads them from the
 * `params` object on its target every frame, and the host writes changes into
 * that same object in place, so a slider moves the picture on the next frame
 * with no allocation and no re-create. A knob that would need a re-create
 * (buffer sizes, particle counts, shader literals) is not a knob.
 *
 * Pure: no Vue, no `@renderer`, so the tests drive it directly.
 */
export interface EffectParamSpec {
  /** Stable; persisted under the effect's id. */
  readonly id: string
  readonly label: string
  /** One line, shown under the slider. */
  readonly help?: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly default: number
  /** How the popover prints the value: `1.25×` for a multiplier, the plain number otherwise. */
  readonly format?: 'multiplier' | 'number'
}

/** The live values an effect reads, by knob id. The host mutates it in place. */
export type EffectParams = Readonly<Record<string, number>>

/**
 * The common shape: a multiplier on the effect's built-in amount, 1× at the
 * untuned look. The range is wide enough to matter and narrow enough that the
 * ends still read as the same effect.
 */
export function multiplierParam(
  id: string,
  label: string,
  help?: string,
  range: { min?: number; max?: number } = {}
): EffectParamSpec {
  return {
    id,
    label,
    help,
    min: range.min ?? 0.25,
    max: range.max ?? 2,
    step: 0.05,
    default: 1,
    format: 'multiplier'
  }
}

function clampToSpec(spec: EffectParamSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.default
  return Math.min(spec.max, Math.max(spec.min, value))
}

/**
 * Fill `out` with this effect's values: the stored one clamped into range where
 * there is one, the default otherwise. In place, so the effect holding `out`
 * sees the change without being told; keys `out` holds that are not knobs any
 * more are removed.
 */
export function writeParams(
  out: Record<string, number>,
  specs: readonly EffectParamSpec[],
  stored: Readonly<Record<string, number>> | undefined
): void {
  for (const key of Object.keys(out)) {
    if (!specs.some((spec) => spec.id === key)) delete out[key]
  }
  for (const spec of specs) {
    const value = stored?.[spec.id]
    out[spec.id] = value === undefined ? spec.default : clampToSpec(spec, value)
  }
}

/** A fresh values object for `specs`, read from `stored`. */
export function resolveParams(
  specs: readonly EffectParamSpec[],
  stored: Readonly<Record<string, number>> | undefined
): Record<string, number> {
  const out: Record<string, number> = {}
  writeParams(out, specs, stored)
  return out
}

/**
 * The stored record with one knob set. A value at the knob's default is
 * removed rather than stored, and an effect left with nothing stored is
 * removed, so the setting only ever holds what the operator has moved.
 */
export function withParam(
  all: VisualizerParamValues,
  effectId: string,
  spec: EffectParamSpec,
  value: number
): VisualizerParamValues {
  const clamped = clampToSpec(spec, value)
  const knobs: Record<string, number> = { ...all[effectId] }
  if (clamped === spec.default) delete knobs[spec.id]
  else knobs[spec.id] = clamped
  const next: Record<string, Readonly<Record<string, number>>> = { ...all }
  if (Object.keys(knobs).length === 0) delete next[effectId]
  else next[effectId] = knobs
  return next
}

/** The stored record with one effect back at its defaults. */
export function withoutParams(all: VisualizerParamValues, effectId: string): VisualizerParamValues {
  if (!(effectId in all)) return all
  const next: Record<string, Readonly<Record<string, number>>> = { ...all }
  delete next[effectId]
  return next
}

/** The value as the popover prints it. */
export function formatParam(spec: EffectParamSpec, value: number): string {
  const decimals = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : 2
  const text = value.toFixed(decimals)
  return spec.format === 'multiplier' ? `${text}×` : text
}
