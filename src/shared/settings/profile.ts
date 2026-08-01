/**
 * Settings profiles: a configuration as a file, and the diff that says what
 * importing one would do.
 *
 * Everything here is pure. Main builds the file and applies the plan, the
 * renderer previews the same plan from the same function, and neither can
 * disagree with the other about what an import means — which matters because the
 * preview is the only thing standing between the operator and an action that
 * reset (W8-7) undoes only in the crudest sense.
 *
 * `descriptors` is a required argument on every function rather than defaulting
 * to `SETTINGS_REGISTRY`, for the reason the kernel is a separate module at all:
 * the registry is assembled one level up in `../settings.ts`, and reaching for it
 * from here would be an import cycle.
 *
 * Root folders are absent by construction. They live in the library database as
 * absolute paths, not in the settings table, so there is no descriptor for the
 * exporter to hold back — the D11 export bundle is what carries a library, and
 * this is only its configuration companion.
 */

import {
  migrateValue,
  resolveDefault,
  sameSettingValue,
  type SettingCategoryId,
  type SettingDescriptor,
  type StoredSetting
} from './kernel'

/** Written into every file, and checked on read. */
export const SETTINGS_PROFILE_FORMAT = 'fermata.settings'

/**
 * The *envelope's* version, which is not a schema version for the values.
 *
 * It bumps only if the shape around `settings` changes. Each key inside carries
 * its own version and runs its own `upgrade` chain on import, which is exactly
 * why W8-1 chose per-key migration: a profile is a bag of independently
 * versioned values, and a single number across all of them would be a lie the
 * moment two builds disagreed about one key.
 */
export const SETTINGS_PROFILE_VERSION = 1

/** What the save dialog suggests, and what the import filter looks for. */
export const SETTINGS_PROFILE_FILE_NAME = 'fermata-settings.json'

export interface SettingsProfile {
  format: typeof SETTINGS_PROFILE_FORMAT
  formatVersion: number
  /** The build that wrote it. Informational — nothing branches on it. */
  app?: string
  /** ISO 8601, so the file says when it was taken without being parsed. */
  exportedAt?: string
  settings: Record<string, StoredSetting>
}

export const SETTINGS_IMPORT_MODES = ['merge', 'replace'] as const

/**
 * Merge applies what the file names. Replace also resets what it does not.
 *
 * Two operations, not one with a flag: an operator restoring a known-good
 * configuration means replace, and one taking two settings off a colleague's
 * machine means merge. Conflating them loses settings in the direction nobody
 * asks for.
 */
export type SettingsImportMode = (typeof SETTINGS_IMPORT_MODES)[number]

/**
 * What the import would do to one key.
 *
 * `unchanged` still writes — see `SettingsImportPlan.apply`. The status
 * describes what the operator will *see*, not whether a row is touched.
 */
export type SettingsImportStatus =
  /** No stored row here, and the file moves the value off its default. */
  | 'new'
  /** A stored value here, and a different one in the file. */
  | 'changed'
  /** The file agrees with what is already in effect. */
  | 'unchanged'
  /** Replace mode: stored here, absent from the file, so back to the default. */
  | 'cleared'
  /** Portable is false, or the key is view state. Never applied. */
  | 'excluded'
  /** Written by a newer build under a version this one cannot read. */
  | 'incompatible'
  /** Survived its migration and was then refused by its own validator. */
  | 'invalid'
  /** No descriptor in this build. Preserved verbatim rather than dropped. */
  | 'unknown'

export interface SettingsImportEntry {
  key: string
  status: SettingsImportStatus
  /** The value in effect now. Absent for an unknown key — nothing resolves it. */
  from?: unknown
  /** What would be in effect afterwards. Absent when nothing is applied. */
  to?: unknown
  /** Why it is excluded, incompatible, invalid or unknown. Shown in the preview. */
  reason?: string
  /** Carried so a preview can name a row without a second registry lookup. */
  label?: string
  category?: SettingCategoryId
}

/** One row to write, already migrated and validated. */
export interface SettingsImportWrite {
  key: string
  value: unknown
  version: number
}

export interface SettingsImportPlan {
  mode: SettingsImportMode
  /** Every key either side mentions, key order, whatever happens to it. */
  entries: readonly SettingsImportEntry[]
  /**
   * Known keys to write, including the ones whose value does not move.
   *
   * A row is part of a configuration in its own right: it is what stops the key
   * tracking a default a later build moves, and it is what the per-row revert
   * offers to delete. An import that skipped the no-op writes would not
   * reproduce the profile it was given, which is the round trip this card is
   * for.
   */
  apply: readonly SettingsImportWrite[]
  /**
   * Keys with no descriptor here, verbatim.
   *
   * The unknown-key preservation rule, pointed the other way: a store must not
   * drop what it does not understand, and neither must an import from a newer
   * build. They are written but never announced — there is no descriptor for a
   * listener to resolve them with.
   */
  preserve: readonly SettingsImportWrite[]
  /** Replace mode only: stored rows to delete so the key returns to default. */
  clear: readonly string[]
}

function portabilityReason(descriptor: SettingDescriptor): string {
  return descriptor.scope === 'view'
    ? 'view state, which is about this window rather than this configuration'
    : 'describes this machine rather than this configuration'
}

export interface BuildSettingsProfileOptions {
  descriptors: readonly SettingDescriptor[]
  /** Resolved global values, defaults included. */
  values: Readonly<Record<string, unknown>>
  /** Keys a surviving stored row supplied. Defaults are not decisions. */
  storedKeys: Iterable<string>
  app?: string
  exportedAt?: string
}

export interface SettingsProfileBuild {
  profile: SettingsProfile
  /** Stored keys held back because they are not portable, for the report. */
  excluded: readonly string[]
}

/**
 * Everything the operator has decided that still means something elsewhere.
 *
 * Stored keys only. A key sitting at its default has not been decided, and
 * writing it into the file would freeze today's default into a configuration
 * that outlives the build which chose it — the profile would quietly pin a value
 * the operator never picked.
 *
 * The exclusion walks `descriptors` and reads `portable`. There is no list here
 * to forget to update.
 */
export function buildSettingsProfile({
  descriptors,
  values,
  storedKeys,
  app,
  exportedAt
}: BuildSettingsProfileOptions): SettingsProfileBuild {
  const stored = new Set(storedKeys)
  const excluded: string[] = []
  const settings: Record<string, StoredSetting> = {}

  // Sorted, because the file is meant to be read and diffed by a person, and
  // registry assembly order would shuffle it whenever a domain module grew a key.
  for (const descriptor of [...descriptors].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!stored.has(descriptor.key)) continue
    if (!descriptor.portable) {
      excluded.push(descriptor.key)
      continue
    }
    if (!(descriptor.key in values)) continue
    const value = values[descriptor.key]
    settings[descriptor.key] = {
      value: value !== null && typeof value === 'object' ? structuredClone(value) : value,
      version: descriptor.version
    }
  }

  return {
    profile: {
      format: SETTINGS_PROFILE_FORMAT,
      formatVersion: SETTINGS_PROFILE_VERSION,
      ...(app === undefined ? {} : { app }),
      ...(exportedAt === undefined ? {} : { exportedAt }),
      settings
    },
    excluded
  }
}

export type SettingsProfileParse =
  { ok: true; profile: SettingsProfile } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a file into a profile, or say what is wrong with it.
 *
 * Strict about the envelope and about every entry, rather than salvaging what
 * parses. These files are small and are advertised as hand-editable, so an
 * operator who breaks one entry is far better served by being told which key
 * than by an import that silently applies the other nineteen.
 */
export function parseSettingsProfile(raw: unknown): SettingsProfileParse {
  if (!isRecord(raw)) return { ok: false, reason: 'expected a JSON object' }
  if (raw.format !== SETTINGS_PROFILE_FORMAT) {
    return { ok: false, reason: `format must be "${SETTINGS_PROFILE_FORMAT}"` }
  }

  const formatVersion = raw.formatVersion
  if (!Number.isInteger(formatVersion) || (formatVersion as number) < 1) {
    return { ok: false, reason: 'formatVersion must be an integer of at least 1' }
  }
  // The envelope, unlike the values inside it, has no upgrade path: a newer one
  // may hold fields this build would have to understand to apply the file
  // safely. Refused with a reason rather than read optimistically.
  if ((formatVersion as number) > SETTINGS_PROFILE_VERSION) {
    return {
      ok: false,
      reason: `formatVersion ${formatVersion} was written by a newer version of Fermata`
    }
  }

  if (!isRecord(raw.settings)) return { ok: false, reason: 'settings must be an object' }

  const settings: Record<string, StoredSetting> = {}
  for (const [key, entry] of Object.entries(raw.settings)) {
    if (!isRecord(entry) || !('value' in entry)) {
      return { ok: false, reason: `settings["${key}"] must be an object with a value` }
    }
    if (!Number.isInteger(entry.version) || (entry.version as number) < 1) {
      return { ok: false, reason: `settings["${key}"].version must be an integer of at least 1` }
    }
    settings[key] = { value: entry.value, version: entry.version as number }
  }

  return {
    ok: true,
    profile: {
      format: SETTINGS_PROFILE_FORMAT,
      formatVersion: formatVersion as number,
      ...(typeof raw.app === 'string' ? { app: raw.app } : {}),
      ...(typeof raw.exportedAt === 'string' ? { exportedAt: raw.exportedAt } : {}),
      settings
    }
  }
}

export interface PlanSettingsImportOptions {
  descriptors: readonly SettingDescriptor[]
  profile: SettingsProfile
  /** Resolved global values as they stand now. */
  values: Readonly<Record<string, unknown>>
  storedKeys: Iterable<string>
  mode: SettingsImportMode
}

/**
 * What importing this file would do, key by key, without doing any of it.
 *
 * The same function answers the preview and drives the apply. Main recomputes it
 * rather than trusting a plan sent over IPC — the renderer is not trusted with
 * writes anywhere else either — and because the inputs are the same on both
 * sides, what is shown is what happens.
 */
export function planSettingsImport({
  descriptors,
  profile,
  values,
  storedKeys,
  mode
}: PlanSettingsImportOptions): SettingsImportPlan {
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  const stored = new Set(storedKeys)
  const entries: SettingsImportEntry[] = []
  const apply: SettingsImportWrite[] = []
  const preserve: SettingsImportWrite[] = []
  const clear: string[] = []

  for (const [key, entry] of Object.entries(profile.settings)) {
    const descriptor = byKey.get(key)

    if (!descriptor) {
      preserve.push({ key, value: entry.value, version: entry.version })
      // A reason rather than a bare row: the preview has no label and no current
      // value to show for a key this build has never heard of, and "future.thing
      // → future.thing" tells the operator nothing about why it is listed.
      entries.push({
        key,
        status: 'unknown',
        to: entry.value,
        reason: 'not a setting this build knows, and kept rather than dropped'
      })
      continue
    }

    const named = { key, label: descriptor.label, category: descriptor.category }

    if (!descriptor.portable) {
      entries.push({
        ...named,
        status: 'excluded',
        from: values[key],
        reason: portabilityReason(descriptor)
      })
      continue
    }

    const resolved = migrateValue(descriptor, entry)
    if (resolved.notice) {
      // `migrateValue` reports both refusals the same way and distinguishes them
      // by whether it wants the caller to rewrite: a value from a newer build is
      // left alone rather than repaired. Neither is applied, but the preview owes
      // the operator the difference between "this build cannot read it" and
      // "this value is not allowed".
      entries.push({
        ...named,
        status: resolved.changed ? 'invalid' : 'incompatible',
        from: values[key],
        reason: resolved.notice.reason
      })
      continue
    }

    const current = values[key]
    const status = sameSettingValue(resolved.value, current)
      ? 'unchanged'
      : stored.has(key)
        ? 'changed'
        : 'new'

    apply.push({ key, value: resolved.value, version: descriptor.version })
    entries.push({ ...named, status, from: current, to: resolved.value })
  }

  if (mode === 'replace') {
    for (const descriptor of descriptors) {
      // Only portable keys are swept. Replace means "make this configuration the
      // one in force", and the output device was never part of the configuration
      // — wiping it would be a machine-local setting lost to an operation that
      // promised to carry one between machines. Unknown rows are left for the
      // same reason a reset leaves them.
      if (!descriptor.portable) continue
      if (!stored.has(descriptor.key)) continue
      if (descriptor.key in profile.settings) continue

      const next = resolveDefault(descriptor)
      clear.push(descriptor.key)
      entries.push({
        key: descriptor.key,
        label: descriptor.label,
        category: descriptor.category,
        status: 'cleared',
        from: values[descriptor.key],
        to: next
      })
    }
  }

  entries.sort((a, b) => a.key.localeCompare(b.key))
  return { mode, entries, apply, preserve, clear }
}

/** Counts for a preview header, so the summary line is not assembled twice. */
export function summarizeSettingsImport(
  plan: SettingsImportPlan
): Record<SettingsImportStatus, number> {
  const counts: Record<SettingsImportStatus, number> = {
    new: 0,
    changed: 0,
    unchanged: 0,
    cleared: 0,
    excluded: 0,
    incompatible: 0,
    invalid: 0,
    unknown: 0
  }
  for (const entry of plan.entries) counts[entry.status] += 1
  return counts
}

// --- IPC shapes --------------------------------------------------------------

export interface SettingsProfileExportResult {
  fileName: string
  /** How many keys travelled. */
  keyCount: number
  /** Which stored keys were held back, so the toast can say so by name. */
  excluded: readonly string[]
}

/** A file the operator chose, parsed but not yet applied. */
export interface SettingsProfileFile {
  fileName: string
  profile: SettingsProfile
}

export interface ImportSettingsProfileRequest {
  profile: SettingsProfile
  mode: SettingsImportMode
}
