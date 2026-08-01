/**
 * Validating the override map on its way in from storage.
 *
 * T6 stores every override in one durable key as a JSON map, which means this
 * is the only gate between whatever is in the database and the theme layer. It
 * has to be forgiving in one specific direction and strict everywhere else:
 * **an entry naming a token the catalog does not define is kept**, because
 * themes gain and lose tokens and switching branches must not destroy an
 * operator's work — the unknown-key rule the settings kernel already follows,
 * applied to custom properties.
 *
 * Everything that is not a plausible value is dropped, though. A `null`, a
 * number, a nested object that is not a ramp spec — those are corruption rather
 * than a token from the future, and keeping them would mean the editor has to
 * render something it cannot describe.
 */

import { RAMP_STEPS, isTailwindPalette, type RampSpec, type RampSteps } from './ramp'
import type { ThemeOverrides } from './resolve'

/**
 * The longest a literal token value may be.
 *
 * A font stack is the legitimate maximum and comfortably fits; anything past
 * this is a paste accident or a stylesheet someone tried to smuggle through the
 * editor. Bounded because this value reaches a `<style>` element.
 */
const MAX_VALUE_LENGTH = 512

/**
 * A value that would let an override break out of the declaration it belongs
 * to. The bridge writes `--token: <value>` into a stylesheet, so a value
 * carrying `;` or a comment terminator could append rules of its own.
 *
 * This is a correctness guard, not a security boundary — the renderer has no
 * filesystem and the operator is the only author. It exists so a stray
 * semicolon in a pasted value corrupts one token instead of the whole sheet.
 */
const UNSAFE = /[;{}]|<\/|\/\*|\*\//

function isSafeValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && !UNSAFE.test(value)
}

function readRampSpec(raw: Record<string, unknown>): RampSpec | null {
  switch (raw.mode) {
    case 'palette':
      return typeof raw.palette === 'string' && isTailwindPalette(raw.palette)
        ? { mode: 'palette', palette: raw.palette }
        : null

    case 'seed':
      return typeof raw.seed === 'string' && isSafeValue(raw.seed)
        ? { mode: 'seed', seed: raw.seed }
        : null

    case 'custom': {
      const steps = raw.steps
      if (typeof steps !== 'object' || steps === null) return null
      const record = steps as Record<string, unknown>
      const out: Partial<Record<string, string>> = {}
      for (const step of RAMP_STEPS) {
        const value = record[step]
        if (typeof value !== 'string' || !isSafeValue(value)) return null
        out[step] = value
      }
      return { mode: 'custom', steps: out as RampSteps }
    }

    default:
      return null
  }
}

/**
 * Read the durable value into an override map, dropping what cannot be a token
 * value and keeping what merely names a token we do not know.
 *
 * Never throws and never returns null — a corrupt blob resolves to "no
 * overrides", which is a theme that renders, rather than to an error that takes
 * the window with it.
 */
export function parseOverrides(raw: unknown): ThemeOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}

  const out: Record<string, string | RampSpec> = {}

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 128) continue

    if (typeof value === 'string') {
      if (isSafeValue(value)) out[key] = value
      continue
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const spec = readRampSpec(value as Record<string, unknown>)
      if (spec) out[key] = spec
    }
  }

  return out
}

/** True when the map holds nothing — the editor's "nothing overridden" state. */
export function hasOverrides(overrides: ThemeOverrides): boolean {
  return Object.keys(overrides).length > 0
}

/**
 * Drop one token's override.
 *
 * Returns a new map rather than mutating, so the caller can compare identity to
 * decide whether a write is needed — reverting an already-default token should
 * not spend a debounced database write.
 */
export function withoutOverride(overrides: ThemeOverrides, id: string): ThemeOverrides {
  if (!Object.hasOwn(overrides, id)) return overrides
  const next = { ...overrides }
  delete next[id]
  return next
}

/** Set one token's override, or clear it when the value is null. */
export function withOverride(
  overrides: ThemeOverrides,
  id: string,
  value: string | RampSpec | null
): ThemeOverrides {
  if (value === null) return withoutOverride(overrides, id)
  return { ...overrides, [id]: value }
}
