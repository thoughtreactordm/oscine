/**
 * Which playlists are open as tabs, across restarts.
 *
 * The rail is the list of every playlist; the strip is the handful the operator
 * is working on. That second set is a statement about a session's *work*, and a
 * player that forgot it on every launch would make the strip a thing you rebuild
 * every morning rather than a thing you keep.
 *
 * §5 rule 5 is not in tension with this. The rule makes the up-next *queue*
 * transient — a queue is a statement about the next few minutes. Which tabs are
 * open is a statement about the workspace, which is the same kind of fact as the
 * column layout and the transport modes, and it is persisted in the same place
 * and for the same reason.
 *
 * `localStorage` rather than the library database, matching `columnLayout` and
 * `transportPreferences`: interface state has no business in a file that is
 * meant to survive being copied between machines. Ids are library-local, so a
 * copied database would restore tabs that mean something else — which is exactly
 * why this does not travel with it.
 */

export interface PlaylistSession {
  /** Open tabs, in tab order. Not necessarily `playlists.position` order. */
  openIds: number[]
  /** The viewed tab, which is always one of `openIds` or `null`. */
  viewedId: number | null
}

export interface PlaylistSessionStorage {
  read(): string | null
  write(value: string): void
}

export const PLAYLIST_SESSION_KEY = 'fermata.playlistTabs.v1'

export function emptyPlaylistSession(): PlaylistSession {
  return { openIds: [], viewedId: null }
}

/**
 * `localStorage`, guarded.
 *
 * A deliberate near-copy of `browserLayoutStorage` rather than an import of it,
 * for the reason `browserTransportStorage` gives: these are islands, and one
 * reaching into another's module for a four-line helper is the first thread of
 * the coupling D4 exists to prevent. Storage can fail on quota or with site data
 * disabled, and a tab set is not worth taking the Curate view down for.
 */
export function browserPlaylistSessionStorage(key = PLAYLIST_SESSION_KEY): PlaylistSessionStorage {
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
        // Nothing useful to do: the tabs stay correct for this session.
      }
    }
  }
}

function isPlaylistId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Reads a stored session, keeping nothing it cannot vouch for.
 *
 * Every field is re-validated rather than cast. This is operator-writable
 * storage that outlives an upgrade, and a stale or hand-edited value must
 * degrade to "no tabs open" — which is a recoverable state, the rail being right
 * there — rather than to a render loop over `undefined`.
 */
export function parsePlaylistSession(raw: string | null): PlaylistSession {
  if (raw === null) return emptyPlaylistSession()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyPlaylistSession()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyPlaylistSession()

  const source = parsed as Partial<Record<keyof PlaylistSession, unknown>>
  const openIds = Array.isArray(source.openIds) ? source.openIds.filter(isPlaylistId) : []
  // Duplicates would render one playlist as two tabs that select each other.
  const unique = [...new Set(openIds)]
  const viewedId =
    isPlaylistId(source.viewedId) && unique.includes(source.viewedId)
      ? source.viewedId
      : (unique[0] ?? null)

  return { openIds: unique, viewedId }
}

export function serializePlaylistSession(session: PlaylistSession): string {
  return JSON.stringify({ openIds: session.openIds, viewedId: session.viewedId })
}
