import type { Track } from './library'

/**
 * The playlist half of the main/renderer contract.
 *
 * Split out of `library.ts` because it is a different noun with a different
 * lifecycle: the library is derived from folders on disk and is rebuilt by
 * rescanning, while a playlist is authored and is the only thing in the
 * database a user can lose. Keeping the two vocabularies apart makes it
 * obvious which side of that line a new field falls on.
 *
 * No Node or Electron imports: the renderer imports this module.
 */

/**
 * One playlist tab.
 *
 * `playlists.position` is deliberately absent. The tab order is the order of
 * the array `playlists.list` returns, and shipping the integer alongside it
 * would give the renderer a second, staler source of truth for the same fact —
 * the exact shape that produces a tab bar disagreeing with itself after a
 * reorder. `playlists.reorder` speaks in indices for the same reason.
 */
export interface Playlist {
  id: number
  name: string
  /**
   * R2's per-boundary policy carrier: zero means gapless, non-zero means
   * crossfade. Persisted and returned here; W3 is what consumes it. Nothing in
   * this module interprets the value beyond bounds-checking it.
   */
  crossfadeMs: number
  /** Entries, not distinct tracks — D12 makes duplicates legal. */
  trackCount: number
  /** ISO 8601, like `LibraryRoot.addedAt`. */
  createdAt: string
  updatedAt: string
}

/**
 * One row of a playlist's contents.
 *
 * `id` is the `playlist_entries` id and it is the identity everywhere in this
 * contract — selection, removal, drag anchors, all of it. D12 makes the same
 * `track_id` legal twice in one playlist, so a caller keying anything off
 * `track.id` would be unable to tell the two rows apart, and would remove or
 * move both when the user meant one.
 *
 * The fractional `position` behind the ordering is not exposed. It is the
 * store's business: a renderer that could read it would sooner or later
 * compute its own midpoint, and the rebalance path would then be corrupting
 * positions the renderer still believed in.
 */
export interface PlaylistEntry {
  id: number
  track: Track
}

/**
 * Where an add or a move lands.
 *
 * Expressed against a neighbour rather than an index, because an index is only
 * meaningful against a list the caller has fully loaded, and the contents pane
 * is virtualized from its first commit. An entry id survives other people's
 * inserts; the index of a row does not.
 *
 * `start` and `end` are separate cases rather than a nullable anchor: "drop at
 * the top" and "drop at the bottom" are both real gestures, and collapsing
 * either into a missing field makes them indistinguishable.
 */
export type PlaylistInsertion =
  | { at: 'start' }
  | { at: 'end' }
  | { at: 'before'; entryId: number }
  | { at: 'after'; entryId: number }

/** A window into one playlist's entries, ordered by position. */
export interface ListPlaylistEntriesQuery {
  playlistId: number
  offset: number
  limit: number
}

export interface ListPlaylistEntriesResult {
  entries: PlaylistEntry[]
  /** Total entries in the playlist, ignoring offset/limit, to size the scrollbar. */
  total: number
}

/**
 * The same window, resolved to entry ids and nothing else.
 *
 * The library list has exactly this pair for exactly this reason: a Shift-range
 * in the contents pane routinely spans rows the pane never loaded, and
 * resolving it through ids keeps the page cache bounded however large the
 * selection grows.
 */
export type ListPlaylistEntryIdsQuery = ListPlaylistEntriesQuery

export interface ListPlaylistEntryIdsResult {
  ids: number[]
  total: number
}

/**
 * Adds a multi-selection in one call.
 *
 * `trackIds` is a list rather than a single id because the gesture it serves is
 * "select four thousand rows and drag them onto a tab". One call per track
 * would be four thousand IPC round trips and four thousand transactions.
 *
 * Duplicates within `trackIds` are preserved, not collapsed: D12 makes the same
 * track legal twice, and a caller that assembled the list from overlapping
 * ranges is entitled to say what it meant.
 */
export interface AddTracksToPlaylistRequest {
  playlistId: number
  trackIds: number[]
  insertion: PlaylistInsertion
}

/**
 * Relocates entries already in the playlist, preserving their relative order.
 *
 * If the anchor entry is itself in `entryIds` the request is a no-op — that is
 * a drag dropped onto its own selection, which is a gesture the user makes and
 * not an error worth interrupting them for.
 */
export interface MovePlaylistEntriesRequest {
  playlistId: number
  entryIds: number[]
  insertion: PlaylistInsertion
}

export interface RemovePlaylistEntriesRequest {
  playlistId: number
  entryIds: number[]
}

export const MAX_PLAYLIST_NAME_LENGTH = 200

/** Mirrors `MAX_TRACK_PAGE`; the contents pane is the same kind of list. */
export const MAX_PLAYLIST_ENTRY_PAGE = 1000

/** Mirrors `MAX_TRACK_ID_PAGE`, and for the same reason. */
export const MAX_PLAYLIST_ENTRY_ID_PAGE = 10_000

/**
 * Largest batch of ids one add, move or remove will accept.
 *
 * Equal to `MAX_FILTER_IDS`, which is the ceiling on a library selection, so
 * any selection the user can actually make is addable in a single call.
 */
export const MAX_PLAYLIST_BATCH = 50_000

/**
 * Sanity ceiling on `crossfadeMs`, not a design decision — R2 fixes the
 * semantics of the value and says nothing about its range. It exists so a unit
 * mix-up (seconds where milliseconds were meant) fails at the seam instead of
 * scheduling a two-hour ramp.
 */
export const MAX_CROSSFADE_MS = 30_000
