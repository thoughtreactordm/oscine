import { isRepeatMode, type RepeatMode } from './traversal'

/**
 * The two transport settings that outlive a session.
 *
 * Shuffle and repeat are modes rather than actions — a player that forgot them
 * on restart would be one the user has to re-arm every launch. The shuffle
 * *seed* is deliberately not among them: design §5 rule 5 keeps traversal
 * transient in v1, so switching shuffle on after a restart reshuffles rather
 * than resurrecting last week's sequence, which is also the only honest thing
 * to do when the library may have been rescanned in between.
 *
 * Renderer-local storage rather than the library database, matching the column
 * layout: this is interface state, and it has no business in a file that is
 * meant to survive being copied between machines.
 */

export interface TransportPreferences {
  repeat: RepeatMode
  shuffle: boolean
}

export interface TransportStorage {
  read(): string | null
  write(value: string): void
}

export const TRANSPORT_PREFERENCES_KEY = 'fermata.transport'

export function defaultTransportPreferences(): TransportPreferences {
  return { repeat: 'off', shuffle: false }
}

/**
 * `localStorage`, guarded.
 *
 * A deliberate near-copy of `browserLayoutStorage` rather than an import of
 * it: panels are islands, and playback reaching into `panels/` for a helper
 * would be the first thread of exactly the coupling D4 exists to prevent. The
 * failure behaviour is the same and for the same reason — storage can fail on
 * quota or with site data disabled, and a repeat mode is not worth taking the
 * transport down for.
 */
export function browserTransportStorage(key = TRANSPORT_PREFERENCES_KEY): TransportStorage {
  return {
    read: () => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    write: (value) => {
      try {
        globalThis.localStorage?.setItem(key, value)
      } catch {
        // Nothing useful to do: the modes stay correct for this session.
      }
    }
  }
}

/** Anything unrecognised degrades to the default, field by field. */
export function readTransportPreferences(storage?: TransportStorage): TransportPreferences {
  const stored = storage?.read()
  if (stored === null || stored === undefined) return defaultTransportPreferences()

  try {
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null) return defaultTransportPreferences()
    const candidate = parsed as Partial<Record<keyof TransportPreferences, unknown>>
    return {
      repeat: isRepeatMode(candidate.repeat) ? candidate.repeat : 'off',
      shuffle: candidate.shuffle === true
    }
  } catch {
    return defaultTransportPreferences()
  }
}

export function writeTransportPreferences(
  storage: TransportStorage | undefined,
  preferences: TransportPreferences
): void {
  storage?.write(JSON.stringify(preferences))
}
