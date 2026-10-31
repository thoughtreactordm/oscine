/**
 * `library.changed` — **D36.9** (oscine-mcp, W24-3).
 *
 * The renderer used to assume it was the only thing editing playlists,
 * corrections and user tags, so a write from anywhere else (an agent through
 * MCP, a dev command, a test harness) stayed invisible until a reload. Each
 * write service now announces what it committed, once per call, and the
 * renderer refetches exactly what is named.
 */

/** What can change under the renderer. */
export const LIBRARY_CHANGE_KINDS = [
  /** A playlist row: created, renamed, deleted, moved in the rail, or its count changed. */
  'playlists',
  /** A playlist's entries were added, moved or removed. */
  'playlistEntries',
  /** The grouped correction layer (`track_overrides`, artwork overrides) — materialised into rows. */
  'overrides',
  /** The generic correction layer (`track_tag_overrides`) — not materialised. */
  'tagOverrides',
  /** User tags on tracks, and with them the vocabulary. */
  'tags'
] as const

export type LibraryChangeKind = (typeof LIBRARY_CHANGE_KINDS)[number]

/**
 * The affected ids of one kind, or `'all'` when the write cannot name them
 * cheaply (a tag rename reaches every track carrying the tag; "discard all"
 * clears every generic correction).
 *
 * Playlist ids for `playlists` and `playlistEntries`; track ids for
 * `overrides`, `tagOverrides` and `tags`.
 */
export type LibraryChangeIds = readonly number[] | 'all'

/** What changed, by kind. An absent kind did not change. */
export type LibraryChangeSet = Partial<Record<LibraryChangeKind, LibraryChangeIds>>

/**
 * Who made the write.
 *
 * `renderer` is the operator's own window: every renderer write path already
 * applies its result locally, so the renderer ignores these rather than
 * reloading what it just drew. `agent` is MCP (W24-4 onward). `main` is
 * anything else — a dev command, a background task, a test.
 */
export type LibraryChangeOrigin = 'renderer' | 'agent' | 'main'

/** The `library.changed` payload: one per committed service call. */
export interface LibraryChanged {
  readonly origin: LibraryChangeOrigin
  readonly changes: LibraryChangeSet
}

function mergeIds(
  a: LibraryChangeIds | undefined,
  b: LibraryChangeIds | undefined
): LibraryChangeIds | undefined {
  if (a === 'all' || b === 'all') return 'all'
  if (a === undefined) return b
  if (b === undefined) return a
  return [...new Set([...a, ...b])]
}

/**
 * Unions two change sets, kind by kind: ids are de-duplicated and `'all'`
 * absorbs any list. Kinds whose ids end up empty are dropped, so an empty
 * result means "nothing to announce".
 */
export function mergeLibraryChanges(a: LibraryChangeSet, b: LibraryChangeSet): LibraryChangeSet {
  const out: Partial<Record<LibraryChangeKind, LibraryChangeIds>> = {}
  for (const kind of LIBRARY_CHANGE_KINDS) {
    const merged = mergeIds(a[kind], b[kind])
    if (merged === undefined) continue
    if (merged !== 'all' && merged.length === 0) continue
    out[kind] = merged === 'all' ? 'all' : [...new Set(merged)]
  }
  return out
}

/** Whether a change set names nothing. */
export function isEmptyLibraryChange(changes: LibraryChangeSet): boolean {
  return LIBRARY_CHANGE_KINDS.every((kind) => {
    const ids = changes[kind]
    return ids === undefined || (ids !== 'all' && ids.length === 0)
  })
}
