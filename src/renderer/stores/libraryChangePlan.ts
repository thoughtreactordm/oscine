import type { LibraryChanged, LibraryChangeIds } from '@shared/libraryChanges'
import { MAX_TAG_TRACK_IDS, type TrackTagsRow, type TrackTagView } from '@shared/tags'

/**
 * The renderer half of `library.changed` — **D36.9** — as pure functions.
 *
 * Kept free of Pinia, `@renderer` and the DOM so it runs under the plain-Node
 * suite; `stores/libraryChanges.ts` is the thin part that bolts it onto the
 * real stores.
 */

/** What a `library.changed` asks the renderer to re-read. */
export interface LibraryRefetchPlan {
  /** Re-read the playlist rail (names, order, counts). */
  readonly playlists: boolean
  /** Playlists whose open pane re-reads its entries, or `'all'`. */
  readonly playlistEntries: LibraryChangeIds
  /** Reload the track list, facets and browse — the materialised rows moved. */
  readonly trackRows: boolean
  /** Tracks whose cached user tags are re-read, or `'all'` cached tracks. */
  readonly tagTracks: LibraryChangeIds
  /** Re-read the tag vocabulary (counts, coined or retired rows). */
  readonly tagVocabulary: boolean
  /** Tracks whose generic corrections moved, for panes that show them. */
  readonly tagOverrides: LibraryChangeIds
}

export const EMPTY_REFETCH_PLAN: LibraryRefetchPlan = {
  playlists: false,
  playlistEntries: [],
  trackRows: false,
  tagTracks: [],
  tagVocabulary: false,
  tagOverrides: []
}

/** Whether a plan asks for nothing. */
export function isEmptyRefetchPlan(plan: LibraryRefetchPlan): boolean {
  const none = (ids: LibraryChangeIds): boolean => ids !== 'all' && ids.length === 0
  return (
    !plan.playlists &&
    !plan.trackRows &&
    !plan.tagVocabulary &&
    none(plan.playlistEntries) &&
    none(plan.tagTracks) &&
    none(plan.tagOverrides)
  )
}

/**
 * Turns a payload into the re-reads it calls for.
 *
 * A change the renderer made itself plans nothing: every renderer write path
 * already applied its result (the playlist store refreshes, the tag store
 * patches its cache, the editor bumps the library version), so acting on the
 * echo again would reload what was just drawn — the double-apply and flicker
 * the card rules out.
 */
export function planLibraryRefetch(event: LibraryChanged): LibraryRefetchPlan {
  if (event.origin === 'renderer') return EMPTY_REFETCH_PLAN
  const { changes } = event
  return {
    playlists: changes.playlists !== undefined || changes.playlistEntries !== undefined,
    playlistEntries: changes.playlistEntries ?? [],
    trackRows: changes.overrides !== undefined,
    tagTracks: changes.tags ?? [],
    tagVocabulary: changes.tags !== undefined,
    tagOverrides: changes.tagOverrides ?? []
  }
}

/** Whether a pane showing `id` is among `ids`. */
export function namesId(ids: LibraryChangeIds, id: number | null): boolean {
  if (id === null) return false
  return ids === 'all' || ids.includes(id)
}

function sameView(a: TrackTagView | undefined, b: TrackTagView): boolean {
  if (a === undefined) return false
  if (a.file.length !== b.file.length || a.user.length !== b.user.length) return false
  if (a.file.some((label, i) => label !== b.file[i])) return false
  return a.user.every((tag, i) => {
    const other = b.user[i]
    return (
      other !== undefined &&
      tag.id === other.id &&
      tag.label === other.label &&
      tag.source === other.source
    )
  })
}

/**
 * Re-reads the cached user tags `ids` names and writes back only what moved.
 *
 * Only tracks already in the cache are fetched: one nobody has looked at will be
 * read on demand the first time something draws it, with the new value. A track
 * the answer leaves out carries nothing, matching `ensureTracks`. A view that
 * comes back identical is not rewritten, so repeating a payload — or receiving
 * one for a change the cache already reflects — touches no reactive entry.
 *
 * Returns the ids whose view changed.
 */
export async function refreshTrackTagCache(
  cache: Map<number, TrackTagView>,
  ids: LibraryChangeIds,
  fetch: (trackIds: number[]) => Promise<readonly TrackTagsRow[]>
): Promise<number[]> {
  const targets =
    ids === 'all' ? [...cache.keys()] : [...new Set(ids)].filter((id) => cache.has(id))
  const changed: number[] = []
  for (let start = 0; start < targets.length; start += MAX_TAG_TRACK_IDS) {
    const chunk = targets.slice(start, start + MAX_TAG_TRACK_IDS)
    const rows = await fetch(chunk)
    const byId = new Map(rows.map((row) => [row.trackId, row]))
    for (const id of chunk) {
      const row = byId.get(id)
      const next: TrackTagView = row ? { file: row.file, user: row.user } : { file: [], user: [] }
      if (sameView(cache.get(id), next)) continue
      cache.set(id, next)
      changed.push(id)
    }
  }
  return changed
}
