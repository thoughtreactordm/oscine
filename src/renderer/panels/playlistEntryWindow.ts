import { computed, ref } from 'vue'
import type { Track, TrackGroup } from '@shared/library'
import {
  MAX_PLAYLIST_ENTRY_ID_PAGE,
  MAX_PLAYLIST_ENTRY_PAGE,
  type ListPlaylistEntriesQuery,
  type ListPlaylistEntriesResult,
  type ListPlaylistEntryGroupsQuery,
  type ListPlaylistEntryGroupsResult,
  type ListPlaylistEntryIdsQuery,
  type ListPlaylistEntryIdsResult,
  type PlaylistEntry,
  type PlaylistEntryOrder
} from '@shared/playlists'
import {
  createIndexedSelection,
  nextFocusIndex,
  selectionIntent,
  type SelectionIntent,
  type SelectionModifiers
} from './indexedSelection'

/**
 * The windowed view of one playlist's entries.
 *
 * `createTrackWindow`'s sibling, and deliberately not an option on it. The two
 * share a shape — a page cache, an id-based selection, a generation counter —
 * but they disagree about the two things that matter most here:
 *
 * - **Identity is `playlist_entries.id`, never `track_id`.** D12 makes the same
 *   track legal twice in one playlist, so every set this module holds is a set
 *   of entry ids. A selection keyed by track id would select both copies of a
 *   duplicate, and a remove would take both when the user pointed at one.
 * - **Position is the truth and no column can change it.** There is no sort
 *   here: `ListPlaylistEntriesQuery` has no ordering to give, because the order
 *   *is* the stored fractional position. `ordering` still exists, but it counts
 *   *edits* rather than re-sorts — a move or a remove relocates rows underneath
 *   whatever index a range selection is holding, exactly as a re-sort does in
 *   the library.
 *
 * Headless, like `trackWindow` and `playlistTabs`: no Pinia, no IPC, no DOM. The
 * store bolts the real `playlists.listEntries` on; everything a duplicate entry
 * can break is reachable from a synthetic source under plain Node.
 */

/** Mirrors `TRACK_PAGE_SIZE`. Rows are the same size and travel the same wire. */
export const PLAYLIST_ENTRY_PAGE_SIZE = 200

/** Mirrors `MAX_CACHED_PAGES` — roughly 6,400 entries held at once. */
export const MAX_CACHED_ENTRY_PAGES = 32

export interface PlaylistEntryWindowDeps {
  fetchPage: (query: ListPlaylistEntriesQuery) => Promise<ListPlaylistEntriesResult>
  /**
   * The same window, ids only. Separate from `fetchPage` for the reason the
   * library's is: a Shift-range routinely spans rows the pane never loaded, and
   * resolving it must be visibly unable to put entries into the page cache.
   */
  fetchIdPage: (query: ListPlaylistEntryIdsQuery) => Promise<ListPlaylistEntryIdsResult>
  /**
   * The album runs, for `album` ordering only.
   *
   * Optional the way `trackWindow`'s is, and unasked-for under `position`: a
   * playlist ordered by its stored sequence has no contiguous runs to describe,
   * so the request would be a query per reload for headers nobody is drawing.
   */
  fetchGroups?: (query: ListPlaylistEntryGroupsQuery) => Promise<ListPlaylistEntryGroupsResult>
  pageSize?: number
  idPageSize?: number
  maxCachedPages?: number
}

export function createPlaylistEntryWindow(deps: PlaylistEntryWindowDeps) {
  const pageSize = deps.pageSize ?? PLAYLIST_ENTRY_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PLAYLIST_ENTRY_PAGE) {
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_PLAYLIST_ENTRY_PAGE}.`)
  }
  const idPageSize = deps.idPageSize ?? MAX_PLAYLIST_ENTRY_ID_PAGE
  if (!Number.isInteger(idPageSize) || idPageSize <= 0 || idPageSize > MAX_PLAYLIST_ENTRY_ID_PAGE) {
    throw new RangeError(
      `idPageSize must be an integer between 1 and ${MAX_PLAYLIST_ENTRY_ID_PAGE}.`
    )
  }
  const maxCachedPages = Math.max(1, deps.maxCachedPages ?? MAX_CACHED_ENTRY_PAGES)

  const playlistId = ref<number | null>(null)
  const total = ref(0)

  /**
   * How the entries are presented. `position` is the playlist; `album` is a
   * view of it — see `PlaylistEntryOrder`.
   *
   * Changing it is an `ordering` bump like an edit, because it is the same
   * event as far as anything holding an index is concerned: every row moves,
   * so a half-resolved Shift-range and the focus index are both stale.
   */
  const order = ref<PlaylistEntryOrder>('position')
  const groups = ref<readonly TrackGroup[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Bumped whenever the page cache changes; `pages` is a plain Map Vue cannot see. */
  const revision = ref(0)

  /**
   * Edit generation. Anything derived from row *positions* is stale when it
   * changes — a response in flight, a half-resolved Shift-range, the focus and
   * anchor indices.
   */
  const ordering = ref(0)

  const pages = new Map<number, PlaylistEntry[]>()
  const pending = new Set<number>()
  let presentingOrdering = ordering.value

  let range = { first: 0, last: 0 }

  function pageOf(index: number): number {
    return Math.floor(index / pageSize)
  }

  /**
   * The ordering, as a query fragment, omitted when it is the default.
   *
   * Every read goes through this rather than naming the field itself: the rows,
   * the ids behind a Shift-range and the walk `resolveSelectedTracks` makes all
   * have to describe *one* list, and a call site that forgot the order would
   * resolve a selection against a sequence the operator is not looking at.
   */
  function windowOrder(): { order?: PlaylistEntryOrder } {
    return order.value === 'position' ? {} : { order: order.value }
  }

  function entryAt(index: number): PlaylistEntry | undefined {
    void revision.value
    return pages.get(pageOf(index))?.[index % pageSize]
  }

  /** The `TrackListSource` row. The entry behind it is what every command uses. */
  function rowAt(index: number): Track | undefined {
    return entryAt(index)?.track
  }

  function evictDistantPages(): void {
    if (pages.size <= maxCachedPages) return

    const firstPage = pageOf(range.first)
    const lastPage = pageOf(range.last)
    const distance = (page: number): number =>
      page < firstPage ? firstPage - page : page > lastPage ? page - lastPage : 0

    const furthestFirst = [...pages.keys()].sort((a, b) => distance(b) - distance(a))
    for (const page of furthestFirst) {
      if (pages.size <= maxCachedPages) break
      if (distance(page) === 0) break
      pages.delete(page)
    }
  }

  /** Ids for an inclusive index range, chunked to the id page ceiling. */
  async function fetchIdRange(first: number, last: number): Promise<number[]> {
    const id = playlistId.value
    if (id === null) return []

    const generation = ordering.value
    const ids: number[] = []

    for (let offset = first; offset <= last; offset += idPageSize) {
      const limit = Math.min(idPageSize, last - offset + 1)
      const result = await deps.fetchIdPage({ playlistId: id, offset, limit, ...windowOrder() })
      if (generation !== ordering.value) return ids
      ids.push(...result.ids)
      // A short page means the playlist ran out before `last` did.
      if (result.ids.length < limit) break
    }

    return ids
  }

  /**
   * An arbitrary entry-id set, put back into playlist order.
   *
   * Walked out of `fetchIdPage` rather than asked for over a dedicated verb the
   * way the library's `orderTrackIds` is. A playlist has exactly one order, so
   * the answer is a filter of the id list the pane can already ask for, and
   * adding an IPC channel to re-derive it in SQL would be a second source of
   * truth for the same sequence. The walk is bounded by the playlist rather than
   * by the library — ten thousand entries is one request — and it only runs when
   * the user acts on a selection, never while scrolling.
   */
  async function orderIds(wanted: readonly number[]): Promise<number[]> {
    const id = playlistId.value
    if (id === null || wanted.length === 0) return []

    const generation = ordering.value
    const remaining = new Set(wanted)
    const ordered: number[] = []

    for (let offset = 0; remaining.size > 0; offset += idPageSize) {
      const result = await deps.fetchIdPage({
        playlistId: id,
        offset,
        limit: idPageSize,
        ...windowOrder()
      })
      if (generation !== ordering.value) return ordered
      for (const entryId of result.ids) {
        if (remaining.delete(entryId)) ordered.push(entryId)
      }
      if (result.ids.length < idPageSize) break
    }

    return ordered
  }

  /**
   * The rows of a contiguous span, as tracks.
   *
   * A span is the one shape that needs no searching: `fetchPage` takes an
   * offset and a limit, so this is the range read straight out, chunked only
   * because the page ceiling says so. `resolveSelectedTracks` walks the whole
   * playlist looking for a scattered set; this knows exactly where its rows
   * are.
   *
   * Tracks and not entry ids, because the queue and the playlists both hold
   * track ids — an entry belongs to the playlist it is in, and a copy of it
   * does not.
   */
  async function tracksInRange(first: number, last: number): Promise<Track[]> {
    const id = playlistId.value
    if (id === null || last < first) return []

    const generation = ordering.value
    const tracks: Track[] = []

    for (let offset = first; offset <= last; offset += pageSize) {
      const limit = Math.min(pageSize, last - offset + 1)
      const result = await deps.fetchPage({ playlistId: id, offset, limit, ...windowOrder() })
      if (generation !== ordering.value) return tracks
      tracks.push(...result.entries.map((entry) => entry.track))
      // A short page means the playlist ran out before `last` did.
      if (result.entries.length < limit) break
    }

    return tracks
  }

  const selection = createIndexedSelection({
    // The entry id, which is the whole of D12's handling in this module.
    idAt: (index) => entryAt(index)?.id,
    fetchIdRange,
    orderIds,
    ordering: () => ordering.value,
    total: () => total.value
  })

  /**
   * The selected rows as the **tracks** they hold, in playlist order.
   *
   * The up-next queue holds track ids, so that deleting the playlist a row was
   * queued from cannot reach it (§5 rule 4) — which means queueing from this
   * pane has to cross from entry identity back to track identity, and only the
   * rows themselves carry both.
   *
   * Walked over `fetchPage` rather than resolved through `fetchIdPage` first:
   * that would be two passes over the same playlist to learn what one pass
   * already knows. It stops as soon as the selection is accounted for, so a
   * selection near the top costs one page whatever the playlist's length, and
   * the worst case — the last row of a long playlist — is that playlist read
   * once in `pageSize` chunks. Only ever on an explicit gesture, never while
   * scrolling.
   */
  async function resolveSelectedTracks(): Promise<Track[]> {
    const id = playlistId.value
    const wanted = new Set(selection.ids.value)
    if (id === null || wanted.size === 0) return []

    const generation = ordering.value
    const tracks: Track[] = []

    for (let offset = 0; wanted.size > 0; offset += pageSize) {
      const result = await deps.fetchPage({
        playlistId: id,
        offset,
        limit: pageSize,
        ...windowOrder()
      })
      if (generation !== ordering.value) return tracks
      for (const entry of result.entries) {
        if (wanted.delete(entry.id)) tracks.push(entry.track)
      }
      if (result.entries.length < pageSize) break
    }

    return tracks
  }

  async function loadPage(page: number): Promise<void> {
    const id = playlistId.value
    if (id === null) return
    if (pending.has(page) || (presentingOrdering === ordering.value && pages.has(page))) return

    const requested = ordering.value
    pending.add(page)
    loading.value = true

    try {
      const result = await deps.fetchPage({
        playlistId: id,
        offset: page * pageSize,
        limit: pageSize,
        ...windowOrder()
      })

      // A response issued before the last edit describes rows that have since
      // moved. Storing it would interleave two orderings in one column.
      if (requested !== ordering.value) return

      if (presentingOrdering !== requested) {
        pages.clear()
        presentingOrdering = requested
      }
      total.value = result.total
      pages.set(page, result.entries)
      selection.adoptPage(result.entries, page, pageSize)
      evictDistantPages()
      error.value = null
      revision.value++
    } catch (cause) {
      if (requested !== ordering.value) return
      error.value = cause instanceof Error ? cause.message : 'Could not read the playlist.'
    } finally {
      if (requested === ordering.value) {
        pending.delete(page)
        loading.value = pending.size > 0
      }
    }
  }

  function ensureRange(first: number, last: number): void {
    range = { first: Math.max(0, first), last: Math.max(0, last) }

    const lastPage = pageOf(range.last)
    for (let page = pageOf(range.first); page <= lastPage; page++) {
      if (total.value > 0 && page * pageSize >= total.value) break
      void loadPage(page)
    }
  }

  function invalidate(): void {
    ordering.value++
    pending.clear()
    loading.value = playlistId.value !== null
    // Positions only. *Which* entries are selected survives an edit, so the rows
    // a user just dragged are still selected where they landed.
    selection.invalidateIndices()
    void refreshGroups()
    ensureRange(range.first, range.last)
  }

  /**
   * Re-reads the album runs, or drops them.
   *
   * Guarded on the generation it started under, like every other read here: an
   * edit or an order change while this is in flight makes the answer describe a
   * list that no longer exists, and a stale run table is worse than none —
   * `TrackList` sizes its virtualizer from it.
   *
   * A failure clears the runs rather than keeping the last good ones. The pane
   * falls back to an ungrouped list, which is always a correct rendering of the
   * rows; headers left over from a previous read are not.
   */
  async function refreshGroups(): Promise<void> {
    const id = playlistId.value
    if (id === null || order.value !== 'album' || !deps.fetchGroups) {
      groups.value = []
      return
    }

    const generation = ordering.value
    try {
      const result = await deps.fetchGroups({ playlistId: id })
      if (generation !== ordering.value) return
      groups.value = result.groups
    } catch {
      if (generation !== ordering.value) return
      groups.value = []
    }
  }

  /**
   * Switches between the stored sequence and the album-major view.
   *
   * Everything the window holds by position is thrown away, because every row
   * has moved: the pages, the range it was showing and the indices behind the
   * selection. Which *entries* are selected survives, exactly as it does across
   * an edit — the operator picked those rows and re-sorting the view is not a
   * reason to unpick them.
   */
  function setOrder(next: PlaylistEntryOrder): void {
    if (order.value === next) return
    order.value = next
    pages.clear()
    revision.value++
    invalidate()
  }

  /**
   * Points the window at another playlist, or at none.
   *
   * The selection is dropped rather than carried across: entry ids are unique
   * per row and not per playlist, so a set held over from the previous tab would
   * highlight unrelated rows in this one.
   */
  function setPlaylist(next: number | null): void {
    if (playlistId.value === next) return
    playlistId.value = next
    pages.clear()
    total.value = 0
    error.value = null
    selection.clear()
    range = { first: 0, last: 0 }
    revision.value++
    ordering.value++
    pending.clear()
    presentingOrdering = ordering.value
    loading.value = false
    groups.value = []
    if (next !== null) {
      void refreshGroups()
      ensureRange(0, pageSize - 1)
    }
  }

  /** Re-reads the playlist under a new edit generation. */
  function reload(): void {
    if (playlistId.value === null) return
    invalidate()
  }

  /**
   * Drops ids the playlist no longer contains out of the selection.
   *
   * Called by whoever removed them, because a removal is an event this window
   * performs on request and not a state it could observe: `total` shrinking says
   * nothing about *which* rows went.
   */
  function forget(removed: Iterable<number>): void {
    const gone = removed instanceof Set ? removed : new Set(removed)
    if (gone.size === 0) return
    const keep = [...selection.ids.value].filter((id) => !gone.has(id))
    selection.retain(keep)
  }

  function moveFocus(
    key: string,
    rowsPerPage: number,
    modifiers: SelectionModifiers = {}
  ): number | null {
    const next = nextFocusIndex(key, selection.focusIndex.value, total.value, rowsPerPage)
    if (next === null) return null

    const intent = selectionIntent(modifiers)
    if (intent === 'toggle') selection.moveFocusOnly(next)
    else void selection.apply(next, intent)
    return next
  }

  function commitFocus(modifiers: SelectionModifiers): void {
    const index = selection.focusIndex.value
    if (index === null) return
    void selection.apply(index, selectionIntent(modifiers))
  }

  const focusedEntry = computed(() => {
    const index = selection.focusIndex.value
    return index === null ? null : (entryAt(index) ?? null)
  })

  return {
    /** `playlist_entries.id`, which is the whole of D12's handling here. */
    rowIdentity: 'entry' as const,
    playlistId,
    total,
    loading,
    error,
    ordering,

    /**
     * `TrackListSource` calls for these two and a playlist has neither.
     *
     * `null` is what tells the list its headers are inert, and it stays `null`
     * under `album` ordering too: the album view is a *view*, chosen from the
     * grouping preference rather than by clicking a column, and a sortable
     * header would offer orders the store cannot express. Position remains the
     * truth underneath. See the note at the top of this module.
     */
    sort: null,
    direction: 'asc' as const,
    order,
    setOrder,
    /**
     * Album runs, empty under `position`.
     *
     * `TrackList` compares their total against this window's own before it
     * draws them, so the moment between an edit and the reload that follows —
     * when the runs describe one row count and `total` another — renders
     * ungrouped rather than wrong.
     */
    groups: computed<readonly TrackGroup[]>(() => groups.value),
    scrollKey: computed(() => `playlist:${playlistId.value ?? 'none'}`),

    pageSize,
    rowAt,
    entryAt,
    entryIdAt: (index: number): number | undefined => entryAt(index)?.id,
    ensureRange,
    reload,
    refreshGroups,
    setPlaylist,
    forget,

    selectedIds: selection.ids,
    selectionCount: selection.count,
    selectionResolving: selection.resolving,
    focusIndex: selection.focusIndex,
    anchorIndex: selection.anchorIndex,
    focusedTrack: computed(() => focusedEntry.value?.track ?? null),
    focusedEntry,
    isSelectedAt: selection.isSelectedAt,
    isSelected: selection.isSelected,
    selectAt: (index: number, intent: SelectionIntent): Promise<void> =>
      selection.apply(index, intent),
    moveFocus,
    commitFocus,
    clearSelection: selection.clear,
    /** The selected rows as entry ids, in playlist order. */
    resolveSelection: selection.resolveSelection,
    /**
     * Entry ids for a contiguous span, resolved through main.
     *
     * The album-header menu's "remove" is what needs *entry* ids rather than
     * track ids: D12 makes the same track legal twice, and removing a run must
     * take the copies inside it and leave the ones outside.
     */
    idsInRange: fetchIdRange,
    tracksInRange,
    /** The same rows as the tracks they hold, for the up-next queue. */
    resolveSelectedTracks,

    /** Test seam: how much of the playlist the pane is actually holding. */
    cachedPageCount: (): number => pages.size
  }
}

export type PlaylistEntryWindow = ReturnType<typeof createPlaylistEntryWindow>
