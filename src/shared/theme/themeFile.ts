/**
 * A theme as a portable file — the `.osctheme` an operator exports, shares, and
 * drops into the themes folder for the picker to find.
 *
 * A settings profile (`../settings/profile.ts`) could carry the theme keys too,
 * and until this landed it did. But a theme is not a configuration: communities
 * trade *themes*, named and self-contained, not a colleague's whole settings
 * table with a palette buried in it. So the theme keys left the profile bundle
 * (they are marked non-portable there) and travel here instead — overrides, the
 * base theme they sit on, and the light/dark mode, under a name the file
 * announces so a picker can list it without opening a dialog.
 *
 * `theme.reactive` is deliberately absent: its accent is taken from whatever is
 * playing, so it is a property of this machine's moment rather than of the
 * authored look, and shipping it would pin one album's colour into a file meant
 * to outlive it — the same reason the seed itself never reaches the settings
 * registry.
 *
 * Pure and `@shared`-only, like everything else in this folder: main builds the
 * file and writes it, the renderer parses candidates it lists, and neither can
 * disagree about what a `.osctheme` means.
 */

import { parseOverrides } from './overrides'
import { type ThemeOverrides } from './resolve'
import { DEFAULT_THEME_ID } from './themes'

/** Written into every file, and checked on read. */
export const THEME_FILE_FORMAT = 'oscine.theme'

/**
 * The envelope's version. Bumps only if the shape *around* the theme changes;
 * the overrides inside are validated by `parseOverrides`, which already tolerates
 * tokens from other builds the way the settings kernel tolerates unknown keys.
 */
export const THEME_FILE_VERSION = 1

/** The extension the save dialog suggests and the import filter looks for. */
export const THEME_FILE_EXTENSION = '.osctheme'

/** Light, dark, or follow the desktop — the same union as `theme.mode`. */
export type ThemeFileMode = 'system' | 'light' | 'dark'

const THEME_FILE_MODES: readonly ThemeFileMode[] = ['system', 'light', 'dark']

/** The longest a theme name may be — the cap `theme.name`'s validator uses. */
const MAX_NAME_LENGTH = 64

export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT
  formatVersion: number
  /** What the picker shows. Set by the operator at export. */
  name: string
  /** The build that wrote it. Informational — nothing branches on it. */
  app?: string
  /** ISO 8601, so the file says when it was taken without being parsed. */
  exportedAt?: string
  /** The built-in theme these overrides sit on — `theme.name`. */
  base: string
  /** Light/dark preference — `theme.mode`. */
  mode: ThemeFileMode
  /** The authored token map — `theme.overrides`. */
  overrides: ThemeOverrides
}

export interface BuildThemeFileOptions {
  name: string
  base: string
  mode: ThemeFileMode
  overrides: ThemeOverrides
  app?: string
  exportedAt?: string
}

/**
 * Assemble a theme file from the three theme keys in force, plus a name.
 *
 * The name is trimmed here so the file never carries the operator's stray
 * whitespace, and the overrides are passed through `parseOverrides` so a file
 * this build wrote is one this build would accept back unchanged.
 */
export function buildThemeFile({
  name,
  base,
  mode,
  overrides,
  app,
  exportedAt
}: BuildThemeFileOptions): ThemeFile {
  return {
    format: THEME_FILE_FORMAT,
    formatVersion: THEME_FILE_VERSION,
    name: name.trim(),
    ...(app === undefined ? {} : { app }),
    ...(exportedAt === undefined ? {} : { exportedAt }),
    base,
    mode,
    overrides: parseOverrides(overrides)
  }
}

export type ThemeFileParse = { ok: true; themeFile: ThemeFile } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a candidate into a theme file, or say what is wrong with it.
 *
 * Strict about the envelope — a wrong or newer `format`/`formatVersion` is
 * refused rather than read optimistically, the same discipline
 * `parseSettingsProfile` keeps — but forgiving about the payload: `mode` falls
 * back to `system` and `overrides` runs through `parseOverrides`, which never
 * throws. `name` and `base` are the two fields a theme cannot do without, so a
 * file missing either is not a theme.
 */
export function parseThemeFile(raw: unknown): ThemeFileParse {
  if (!isRecord(raw)) return { ok: false, reason: 'expected a JSON object' }

  if (raw.format !== THEME_FILE_FORMAT) {
    return { ok: false, reason: `format must be "${THEME_FILE_FORMAT}"` }
  }

  const formatVersion = raw.formatVersion
  if (!Number.isInteger(formatVersion) || (formatVersion as number) < 1) {
    return { ok: false, reason: 'formatVersion must be an integer of at least 1' }
  }
  if ((formatVersion as number) > THEME_FILE_VERSION) {
    return {
      ok: false,
      reason: `formatVersion ${formatVersion} was written by a newer version of Oscine`
    }
  }

  if (typeof raw.name !== 'string') return { ok: false, reason: 'name must be a string' }
  const name = raw.name.trim()
  if (name.length === 0) return { ok: false, reason: 'name is empty' }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: 'name is too long' }

  if (typeof raw.base !== 'string' || raw.base.trim().length === 0) {
    return { ok: false, reason: 'base must be a non-empty theme id' }
  }

  const mode = THEME_FILE_MODES.includes(raw.mode as ThemeFileMode)
    ? (raw.mode as ThemeFileMode)
    : 'system'

  return {
    ok: true,
    themeFile: {
      format: THEME_FILE_FORMAT,
      formatVersion: formatVersion as number,
      name,
      ...(typeof raw.app === 'string' ? { app: raw.app } : {}),
      ...(typeof raw.exportedAt === 'string' ? { exportedAt: raw.exportedAt } : {}),
      base: raw.base.trim(),
      mode,
      overrides: parseOverrides(raw.overrides)
    }
  }
}

// --- IPC shapes --------------------------------------------------------------

/** A theme file the picker lists, identified by its filename stem. */
export interface InstalledTheme {
  /** The filename without its extension — stable across a rename of `name`. */
  id: string
  name: string
  base: string
  mode: ThemeFileMode
  overrides: ThemeOverrides
}

/** Default base for a file assembled before any theme was chosen. */
export const DEFAULT_THEME_FILE_BASE = DEFAULT_THEME_ID
