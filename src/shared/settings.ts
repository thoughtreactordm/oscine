/**
 * The settings registry: one assembled list of every key Fermata knows about,
 * and the pure functions that turn a store's contents into usable values.
 *
 * This is a cross-process contract, which is why it sits in `src/shared`
 * alongside `ipc.ts`. Main resolves durable keys before the window opens, the
 * renderer generates its settings UI from the same descriptors, and neither can
 * drift because there is only one set of definitions.
 *
 * Nothing here stores anything, crosses IPC, or knows about Vue. The kernel and
 * the per-domain descriptor modules live in `./settings/`; this file composes
 * them and adds the registry-wide operations.
 */

import { AUDIO_SETTINGS } from './settings/audio'
import { INTERFACE_SETTINGS } from './settings/interface'
import { LIBRARY_SETTINGS } from './settings/library'
import {
  migrateValue,
  resolveDefault,
  SETTING_CATEGORIES,
  type SettingCategoryId,
  type SettingDescriptor,
  type SettingNotice,
  type SettingScope,
  type StoredSetting
} from './settings/kernel'

export * from './settings/kernel'
export type { AlbumArtSize, ThemeMode } from './settings/interface'
export type { RepeatMode, ReplayGainMode } from './settings/audio'

/**
 * Every known key, in one list.
 *
 * Ordering here is assembly order and means nothing; W8-4 sorts by category
 * order then `order`. What the list *is* authoritative about is membership: a
 * key absent from here is unknown, and unknown keys are preserved rather than
 * resolved (see `resolveSettings`).
 */
export const SETTINGS_REGISTRY: readonly SettingDescriptor[] = Object.freeze([
  ...AUDIO_SETTINGS,
  ...LIBRARY_SETTINGS,
  ...INTERFACE_SETTINGS
])

const BY_KEY: ReadonlyMap<string, SettingDescriptor> = new Map(
  SETTINGS_REGISTRY.map((descriptor) => [descriptor.key, descriptor])
)

export function getSetting(key: string): SettingDescriptor | null {
  return BY_KEY.get(key) ?? null
}

export function settingsInScope(scope: SettingScope): readonly SettingDescriptor[] {
  return SETTINGS_REGISTRY.filter((descriptor) => descriptor.scope === scope)
}

/** Descriptors for one category rail entry, in display order. */
export function settingsInCategory(category: SettingCategoryId): readonly SettingDescriptor[] {
  return SETTINGS_REGISTRY.filter((descriptor) => descriptor.category === category).sort(
    (a, b) => a.order - b.order
  )
}

/** Every key's default, optionally narrowed to one scope. */
export function resolveDefaults(scope?: SettingScope): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const descriptor of SETTINGS_REGISTRY) {
    if (scope && descriptor.scope !== scope) continue
    out[descriptor.key] = resolveDefault(descriptor)
  }
  return out
}

export interface SettingsResolution {
  /** Resolved values for every known key in scope — defaults included. */
  values: Record<string, unknown>
  /**
   * Stored entries with no descriptor, verbatim.
   *
   * The registry defines what is *known*, not what a store is allowed to hold.
   * A branch that adds `audio.newThing`, run once, then switched away from,
   * must still have that key when it is switched back to — so a store hands
   * these straight back to disk rather than dropping them.
   */
  unknown: Record<string, StoredSetting>
  /** Stored values that were repaired, migrated or discarded. */
  notices: SettingNotice[]
  /** Known keys whose persisted form is now stale and should be rewritten. */
  rewrite: string[]
}

/**
 * Resolve a whole store in one pass.
 *
 * `scope` narrows which descriptors participate — main resolves `durable` from
 * SQLite, the renderer resolves `view` from localStorage — but a stored key
 * belonging to the *other* scope is still not "unknown", so it lands in neither
 * `values` nor `unknown` and is left for the store that owns it.
 */
export function resolveSettings(
  stored: Readonly<Record<string, StoredSetting>>,
  scope?: SettingScope
): SettingsResolution {
  const values: Record<string, unknown> = {}
  const unknown: Record<string, StoredSetting> = {}
  const notices: SettingNotice[] = []
  const rewrite: string[] = []

  for (const [key, entry] of Object.entries(stored)) {
    const descriptor = BY_KEY.get(key)
    if (!descriptor) {
      unknown[key] = entry
      continue
    }
    if (scope && descriptor.scope !== scope) continue

    const resolved = migrateValue(descriptor, entry)
    values[key] = resolved.value
    if (resolved.notice) notices.push(resolved.notice)
    if (resolved.changed) rewrite.push(key)
  }

  for (const descriptor of SETTINGS_REGISTRY) {
    if (scope && descriptor.scope !== scope) continue
    if (!(descriptor.key in values)) values[descriptor.key] = resolveDefault(descriptor)
  }

  return { values, unknown, notices, rewrite }
}

/**
 * Cross-descriptor invariants, as a list of complaints.
 *
 * `defineSetting` catches everything a descriptor can be wrong about on its
 * own; this catches what only shows up once they are in a list together. It is
 * a function rather than a module-load assertion so a test can point it at a
 * hand-built registry too.
 */
export function auditRegistry(
  descriptors: readonly SettingDescriptor[] = SETTINGS_REGISTRY
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const slots = new Map<string, string>()

  for (const descriptor of descriptors) {
    if (seen.has(descriptor.key)) problems.push(`duplicate key: ${descriptor.key}`)
    seen.add(descriptor.key)

    const slot = `${descriptor.category}#${descriptor.order}`
    const holder = slots.get(slot)
    if (holder) {
      problems.push(`${descriptor.key} and ${holder} both sit at ${slot}`)
    } else {
      slots.set(slot, descriptor.key)
    }

    if (!SETTING_CATEGORIES.some((c) => c.id === descriptor.category)) {
      problems.push(`${descriptor.key}: unknown category ${descriptor.category}`)
    }
  }

  return problems
}
