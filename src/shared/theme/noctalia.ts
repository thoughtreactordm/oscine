/**
 * Noctalia desktop colours — the Linux-only second colour source.
 *
 * Noctalia (the Wayland shell, Quickshell v4 and its own v5+) renders a user
 * template on every colour-scheme change. Setup installs ours; Noctalia writes
 * the result as a small versioned JSON of Material roles, and main watches that
 * one file. Nothing here reads Noctalia's own configuration or imports arbitrary
 * CSS: the exchange format is colour-only and validated role by role.
 *
 * What the desktop is *not* given is the accent. Primary stays where it has
 * always come from — the selected theme, the operator's own `color.primary`
 * override, or the cover art when reactive colour is on — so Noctalia supplies
 * the neutral surfaces, text and borders and the supporting roles around it.
 * That is why `primary` is not in the exported roles at all: a value the app
 * never reads has no business in the contract.
 */

import type { ThemeOverrides } from './resolve'
import type { ThemeMode } from './themes'

/** Where the colours come from. `noctalia` is honoured on Linux only. */
export type ThemeColorSource = 'oscine' | 'noctalia'
export type NoctaliaVersion = 'auto' | 'v4' | 'v5'

/** Noctalia names user templates; this is ours in both config formats. */
export const NOCTALIA_TEMPLATE_NAME = 'oscine'

/**
 * The Material roles the template exports, in both variants.
 *
 * `tertiary` feeds info — Material has no info role, and tertiary is the
 * scheme's other free accent, which is what info is in this app.
 */
export const NOCTALIA_ROLES = [
  'secondary',
  'tertiary',
  'error',
  'surface',
  'surface_container_low',
  'surface_container',
  'surface_container_high',
  'on_surface',
  'on_surface_variant',
  'outline_variant',
  'inverse_surface',
  'inverse_on_surface'
] as const

export type NoctaliaRole = (typeof NOCTALIA_ROLES)[number]
export type NoctaliaColors = Readonly<Record<NoctaliaRole, string>>

export interface NoctaliaPalette {
  readonly version: 1
  readonly light: NoctaliaColors
  readonly dark: NoctaliaColors
}

export interface NoctaliaStatus {
  readonly state: 'disabled' | 'waiting' | 'synced' | 'error' | 'unsupported'
  /** The last valid palette. Kept through a malformed write while syncing. */
  readonly palette: NoctaliaPalette | null
  /** Safe to show: names no absolute path, like every message that crosses IPC. */
  readonly message: string
}

export interface NoctaliaSetupResult {
  readonly version: 'v4' | 'v5'
  readonly message: string
}

const HEX = /^#[\da-f]{6}$/i

export function parseNoctaliaPalette(raw: unknown): NoctaliaPalette {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) {
    throw new Error('Unsupported Noctalia palette format. Run Set up Noctalia again.')
  }
  const variant = (mode: ThemeMode): NoctaliaColors => {
    const colors = (raw as Record<string, unknown>)[mode]
    if (!colors || typeof colors !== 'object') throw new Error(`Missing ${mode} palette.`)
    const parsed = {} as Record<NoctaliaRole, string>
    for (const role of NOCTALIA_ROLES) {
      const color = (colors as Record<string, unknown>)[role]
      if (typeof color !== 'string' || !HEX.test(color)) {
        throw new Error(`Invalid Noctalia color: ${mode}.${role}. Regenerate the Noctalia theme.`)
      }
      parsed[role] = color
    }
    return parsed
  }
  return { version: 1, light: variant('light'), dark: variant('dark') }
}

/** Both template engines support explicit light/dark Material roles. */
export function noctaliaTemplate(): string {
  const variant = (mode: ThemeMode): Record<string, string> =>
    Object.fromEntries(NOCTALIA_ROLES.map((role) => [role, `{{colors.${role}.${mode}.hex}}`]))
  return `${JSON.stringify({ version: 1, light: variant('light'), dark: variant('dark') }, null, 2)}\n`
}

/**
 * Desktop colours over the operator's overrides, for every role but primary.
 *
 * The desktop wins where it speaks: an operator who chose Noctalia chose its
 * surfaces over the ones they authored, and those overrides come back untouched
 * the moment the source is switched back. Fonts, shape and motion still apply.
 *
 * `color.primary` and `accent.primary` are never written, which is the whole
 * contract with reactive colour: `withReactiveSeed` steps aside only for an
 * operator's own `color.primary`, so the cover art keeps the accent exactly as
 * it does without Noctalia, and the theme's primary shows when nothing plays.
 */
export function withNoctaliaColors(
  overrides: ThemeOverrides,
  palette: NoctaliaPalette | null,
  mode: ThemeMode
): ThemeOverrides {
  if (!palette) return overrides
  const c = palette[mode]
  return {
    ...overrides,
    'color.secondary': { mode: 'seed', seed: c.secondary },
    'color.info': { mode: 'seed', seed: c.tertiary },
    'color.error': { mode: 'seed', seed: c.error },
    'color.neutral': { mode: 'seed', seed: c.surface },
    'accent.secondary': c.secondary,
    'accent.info': c.tertiary,
    'accent.error': c.error,
    'surface.base': c.surface,
    'surface.muted': c.surface_container_low,
    'surface.elevated': c.surface_container,
    'surface.accented': c.surface_container_high,
    'surface.inverted': c.inverse_surface,
    'text.base': c.on_surface,
    'text.highlighted': c.on_surface,
    'text.toned': c.on_surface_variant,
    'text.muted': c.on_surface_variant,
    'text.dimmed': c.on_surface_variant,
    'text.inverted': c.inverse_on_surface,
    // Material outlines are too heavy across a dense desktop layout. Surface
    // steps separate panels; the softer outline marks control edges.
    'border.base': c.surface_container_high,
    'border.muted': c.surface_container,
    'border.accented': c.outline_variant,
    'border.inverted': c.inverse_surface
  }
}
