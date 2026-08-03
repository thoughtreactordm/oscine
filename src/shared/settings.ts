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
import { NETWORK_SETTINGS } from './settings/network'
import { THEME_SETTINGS } from './settings/theme'
import { VIEW_SETTINGS } from './settings/view'
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
export * from './settings/scope'
export * from './settings/cascade'
export * from './settings/profile'
export {
  CONFIRM_ENTRY_REMOVAL_KEY,
  CONFIRM_PLAYLIST_DELETE_KEY,
  DATE_FORMAT_KEY,
  DURATION_FORMAT_KEY,
  FACET_ACTIVATION_KEY,
  FILE_SIZE_FORMAT_KEY,
  NOW_PLAYING_WAVEFORM_KEY,
  RESTORE_SESSION_KEY,
  TRACK_ACTIVATION_KEY,
  TRACK_DENSITY_KEY
} from './settings/interface'
export type {
  AlbumArtSize,
  DateFormat,
  DurationFormat,
  FacetActivation,
  FileSizeFormat,
  TrackActivation,
  TrackDensity
} from './settings/interface'
export {
  AUDIO_CROSSFADE_MS,
  AUDIO_CROSSFADE_MS_KEY,
  AUDIO_DECODE_RESIDENCY_BUDGET_MB,
  AUDIO_DECODE_TRACK_CAP_MB,
  AUDIO_NUMERIC_BOUNDS,
  AUDIO_OUTPUT_DEVICE,
  AUDIO_PREFETCH_DEPTH,
  AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING,
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB,
  MIB,
  PLAYBACK_REPEAT,
  PLAYBACK_SHUFFLE,
  boundaryPolicy,
  clampSetting
} from './settings/audio'
export type { BoundaryPolicy, RepeatMode, ReplayGainMode } from './settings/audio'
export {
  THEME_MODE_KEY,
  THEME_NAME_KEY,
  THEME_OVERRIDES_KEY,
  THEME_REACTIVE_KEY,
  THEME_SETTINGS
} from './settings/theme'
export type { ThemeModePreference } from './settings/theme'
export { NETWORK_EXTERNAL_LOOKUPS_KEY, NETWORK_SETTINGS } from './settings/network'
export type { StoredColumnLayout, TabSession } from './settings/view'

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
  ...INTERFACE_SETTINGS,
  ...THEME_SETTINGS,
  ...NETWORK_SETTINGS,
  ...VIEW_SETTINGS
])

function indexByKey(
  descriptors: readonly SettingDescriptor[]
): ReadonlyMap<string, SettingDescriptor> {
  return new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
}

const BY_KEY = indexByKey(SETTINGS_REGISTRY)

export function getSetting(key: string): SettingDescriptor | null {
  return BY_KEY.get(key) ?? null
}

export function settingsInScope(scope: SettingScope): readonly SettingDescriptor[] {
  return SETTINGS_REGISTRY.filter((descriptor) => descriptor.scope === scope)
}

/**
 * One key's default, for code that needs it without a store.
 *
 * Throws on an unknown key rather than returning undefined: the caller is
 * naming a key it believes in, and a typo that silently produced `undefined`
 * would surface as a broken control three layers away.
 */
export function settingDefault<T>(key: string): T {
  const descriptor = getSetting(key)
  if (!descriptor) throw new RangeError(`unknown setting: ${key}`)
  return resolveDefault(descriptor) as T
}

/**
 * Descriptors for one category rail entry, in display order.
 *
 * Internal keys are not among them. They carry a category so that a reset by
 * category reaches them — closing every tab is part of resetting Interface —
 * but they have no control and so no row to place.
 */
export function settingsInCategory(category: SettingCategoryId): readonly SettingDescriptor[] {
  return SETTINGS_REGISTRY.filter(
    (descriptor) => descriptor.category === category && !descriptor.internal
  ).sort((a, b) => a.order - b.order)
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
 * SQLite, the renderer resolves `view` from its own view store — but a stored key
 * belonging to the *other* scope is still not "unknown", so it lands in neither
 * `values` nor `unknown` and is left for the store that owns it.
 *
 * `descriptors` defaults to the registry and exists so a test can resolve
 * against a hand-built one, the same reason `auditRegistry` takes it. Every key
 * in the real registry is at version 1 until one of them changes shape, so
 * without this the upgrade-on-read path has nothing to exercise it.
 */
export function resolveSettings(
  stored: Readonly<Record<string, StoredSetting>>,
  scope?: SettingScope,
  descriptors: readonly SettingDescriptor[] = SETTINGS_REGISTRY
): SettingsResolution {
  const byKey = descriptors === SETTINGS_REGISTRY ? BY_KEY : indexByKey(descriptors)
  const values: Record<string, unknown> = {}
  const unknown: Record<string, StoredSetting> = {}
  const notices: SettingNotice[] = []
  const rewrite: string[] = []

  for (const [key, entry] of Object.entries(stored)) {
    const descriptor = byKey.get(key)
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

  for (const descriptor of descriptors) {
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

    // Internal keys have no row, so two of them sharing an order is not a
    // collision — there is nothing to collide.
    if (!descriptor.internal) {
      const slot = `${descriptor.category}#${descriptor.order}`
      const holder = slots.get(slot)
      if (holder) {
        problems.push(`${descriptor.key} and ${holder} both sit at ${slot}`)
      } else {
        slots.set(slot, descriptor.key)
      }
    }

    if (!SETTING_CATEGORIES.some((c) => c.id === descriptor.category)) {
      problems.push(`${descriptor.key}: unknown category ${descriptor.category}`)
    }
  }

  return problems
}
