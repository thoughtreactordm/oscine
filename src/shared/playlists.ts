import type { Track, TrackGroup } from './library'

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
  /** Entries, not distinct tracks — D12 makes duplicates legal. */
  trackCount: number
  /** ISO 8601, like `LibraryRoot.addedAt`. */
  createdAt: string
  updatedAt: string
  /** `'smart'` marks a playlist an agent may keep up to date on request (D36.8). */
  kind: PlaylistKind
  /** The operator's plain-language description of what belongs; null when unset. */
  brief: string | null
  /** The agent's scratch: what it queried and ruled out. Null until one writes it. */
  agentNotes: string | null
  /** ISO 8601: when an agent last added to it or updated its notes. */
  refreshedAt: string | null
  /** Tracks kept out of it by the operator or an agent (`playlist_exclusions`). */
  exclusionCount: number
}

/**
 * What kind of playlist a row is — **W24-9**, `oscine-mcp` → D36.8.
 *
 * `smart` is not a rule-evaluated playlist: it is an ordinary playlist flagged
 * as one an agent may keep up to date when the operator asks. The app never
 * refreshes one on its own (D36). An enum rather than a boolean, so a
 * rule-evaluated kind can join later without another column.
 */
export const PLAYLIST_KINDS = ['static', 'smart'] as const

export type PlaylistKind = (typeof PLAYLIST_KINDS)[number]

/** Who kept a track out of a smart playlist. */
export const PLAYLIST_EXCLUSION_SOURCES = ['operator', 'agent'] as const

export type PlaylistExclusionSource = (typeof PLAYLIST_EXCLUSION_SOURCES)[number]

/** One excluded track, with enough of the track to name it in the header. */
export interface PlaylistExclusion {
  trackId: number
  title: string | null
  artist: string | null
  source: PlaylistExclusionSource
  /** ISO 8601. */
  createdAt: string
}

export const MAX_PLAYLIST_BRIEF_LENGTH = 2000

export const MAX_PLAYLIST_AGENT_NOTES_LENGTH = 8000

export interface SetPlaylistKindRequest {
  playlistId: number
  kind: PlaylistKind
}

export interface SetPlaylistBriefRequest {
  playlistId: number
  /** Null or empty clears it. */
  brief: string | null
}

export interface ClearPlaylistExclusionsRequest {
  playlistId: number
  /** The tracks to let back in; omitted means every exclusion. */
  trackIds?: number[]
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

/**
 * How a playlist's entries are presented.
 *
 * `position` is the stored fractional order and the only one a reorder drag can
 * be interpreted against — it is what the playlist *is*.
 *
 * `album` is a view over the same entries, ordered exactly as the library's
 * album-major sort orders tracks, so the contents pane can draw the same album
 * headers. It changes nothing stored: the positions are untouched and switching
 * back shows the authored sequence again. What it does cost is the reorder
 * drag, which the pane disables while it is on — a drop between two rows has no
 * meaning when the rows the operator sees are not the rows the order is made
 * of.
 */
export type PlaylistEntryOrder = 'position' | 'album'

/** A window into one playlist's entries. */
export interface ListPlaylistEntriesQuery {
  playlistId: number
  offset: number
  limit: number
  /** Defaults to `position`, which is what every caller wanted before there was a choice. */
  order?: PlaylistEntryOrder
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
 * The album runs of a playlist, under `album` ordering.
 *
 * Carries no ordering of its own, because there is only one it could describe:
 * runs are contiguous only under the album-major sort, exactly as
 * `library.listTrackGroups` requires. Asking for these against `position` order
 * would be asking which albums a shuffled list happens to have adjacent, which
 * is a different question and not one the pane asks.
 *
 * Unpaged, for the reason the library's is: the answer is bounded by how many
 * albums a playlist draws from rather than by how many entries it has.
 */
export interface ListPlaylistEntryGroupsQuery {
  playlistId: number
}

export interface ListPlaylistEntryGroupsResult {
  groups: TrackGroup[]
  /** Entries across every run — the same number `listEntries` reports. */
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

/**
 * Removes entries. From a smart playlist (D36.8) the operator's removal also
 * excludes each track left with no entry, so an agent's next refresh does not
 * bring it back; adding it again by hand clears that.
 */
export interface RemovePlaylistEntriesRequest {
  playlistId: number
  entryIds: number[]
}

/**
 * How an exported `.m3u8` addresses its tracks.
 *
 * Both are legitimate and neither is a default the other camp can be talked out
 * of: `relative` is what lets a playlist be copied to a phone or a NAS beside
 * the music it names, `absolute` is what lets it resolve from anywhere on the
 * machine that wrote it. D12 makes export the interop escape hatch, so the
 * operator picks per export rather than living with whichever one a setting
 * happened to hold.
 */
export const PLAYLIST_PATH_STYLES = ['relative', 'absolute'] as const

export type PlaylistPathStyle = (typeof PLAYLIST_PATH_STYLES)[number]

export interface ExportPlaylistRequest {
  playlistId: number
  pathStyle: PlaylistPathStyle
}

/** What a completed export reports back. */
export interface PlaylistExportResult {
  /**
   * The file's name, never its directory. `IpcErrorPayload` promises that
   * nothing crossing this boundary carries an absolute path, and a success
   * payload has no more business disclosing the filesystem layout than a
   * failure does — the operator chose the folder and already knows it.
   */
  fileName: string
  /** Entries written. */
  entryCount: number
  /**
   * Entries left out because their file no longer resolves inside its root — an
   * unmounted drive, or a root removed since the entry was added. Counted
   * rather than silently dropped: a playlist that exports two tracks short is
   * the kind of thing an operator discovers months later, somewhere else.
   */
  skippedCount: number
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
