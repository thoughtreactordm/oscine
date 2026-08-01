import type { ViewSettings, ViewStorageArea } from './viewStore'
import { VIEW_STORAGE_PREFIX } from './viewStore'

/**
 * The six browser-storage keys that existed before there was a view store,
 * and what each one becomes.
 *
 * A pre-W8-3 profile has pane widths, open tabs, column layouts and transport
 * modes in these; an operator who upgrades must not find any of it gone. Each
 * is read once, written into the registry-backed store, and then removed — so
 * a second launch finds nothing and does nothing.
 *
 * This list only ever shrinks. When enough releases have passed that nobody is
 * upgrading across them, the entries go and this file goes with them; until
 * then a key removed from here is an operator's layout silently discarded.
 */

export interface LegacyViewKey {
  /** What a pre-W8-3 build wrote. */
  storageKey: string
  /**
   * Registry key to value, for every field the blob actually carried.
   *
   * Absent fields are omitted rather than passed as `undefined`: a validator
   * would reject one and file a notice, and "this old blob predates the
   * shuffle flag" is not something to tell an operator about.
   */
  absorb(raw: unknown): Record<string, unknown>
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

/** Copies `from` to `to` only when the legacy blob actually had the field. */
function carry(
  source: Record<string, unknown> | null,
  map: Readonly<Record<string, string>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!source) return out
  for (const [from, to] of Object.entries(map)) {
    if (from in source) out[to] = source[from]
  }
  return out
}

export const LEGACY_VIEW_KEYS: readonly LegacyViewKey[] = [
  {
    // `playback/transportPreferences.ts`
    storageKey: 'fermata.transport',
    absorb: (raw) =>
      carry(asRecord(raw), { repeat: 'playback.repeat', shuffle: 'playback.shuffle' })
  },
  {
    // `shell/shellLayout.ts`
    storageKey: 'fermata.shellLayout.v1',
    absorb: (raw) => carry(asRecord(raw), { paneSizes: 'view.shellPaneSizes' })
  },
  {
    // `panels/columnLayout.ts` — the whole blob is the value, not a field of it.
    storageKey: 'fermata.trackColumns.v1',
    absorb: (raw) => (asRecord(raw) ? { 'view.trackColumns': raw } : {})
  },
  {
    // `panels/groupingLayout.ts`
    storageKey: 'fermata.trackGrouping.v1',
    absorb: (raw) =>
      carry(asRecord(raw), {
        enabled: 'view.trackGroupingEnabled',
        artSize: 'view.trackGroupingArtSize'
      })
  },
  {
    // `panels/playlistSession.ts`
    storageKey: 'fermata.playlistTabs.v1',
    absorb: (raw) => (asRecord(raw) ? { 'view.playlistTabs': raw } : {})
  },
  {
    // `panels/podcastSession.ts` — `focusEpisodeId` is dropped by the
    // descriptor, as it always was: a scroll target is a one-shot instruction
    // to the show pane, and restoring one would yank the list on launch.
    storageKey: 'fermata.podcastSession.v1',
    absorb: (raw) => (asRecord(raw) ? { 'view.podcastTabs': raw } : {})
  }
]

/**
 * Absorbs whatever a pre-W8-3 profile left behind. Returns the keys it cleared.
 *
 * Idempotent by construction: the legacy key is gone afterwards, so the second
 * run reads null and returns nothing.
 *
 * Two orderings matter. A key that already has a registry entry is *not*
 * overwritten — an operator who has run this build and then run an older one,
 * which rewrote its own key, should keep what this build knows rather than have
 * it clobbered by the older shape. And the legacy keys are removed only after
 * the absorbed values have been flushed to storage, so a crash in between
 * leaves the migration to be re-run rather than leaving nothing at either
 * address.
 */
export function absorbLegacyViewKeys(
  settings: ViewSettings,
  storage?: ViewStorageArea,
  legacy: readonly LegacyViewKey[] = LEGACY_VIEW_KEYS
): string[] {
  if (!storage) return []

  const cleared: string[] = []

  for (const entry of legacy) {
    const raw = storage.read(entry.storageKey)
    if (raw === null) continue
    cleared.push(entry.storageKey)

    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A blob that is not JSON carries nothing to absorb. It is still cleared:
      // leaving it means retrying the same failure on every launch forever.
    }

    for (const [key, value] of Object.entries(entry.absorb(parsed))) {
      if (storage.read(VIEW_STORAGE_PREFIX + key) !== null) continue
      settings.set(key, value)
    }
  }

  if (!cleared.length) return cleared

  settings.flush()
  for (const storageKey of cleared) storage.remove(storageKey)
  return cleared
}
