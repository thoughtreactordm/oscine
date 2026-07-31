import { FermataError } from '@shared/errors'
import {
  MAX_FACET_ID_PAGE,
  MAX_FACET_PAGE,
  MAX_FILTER_IDS,
  MAX_ORDERED_TRACK_IDS,
  MAX_SEARCH_LENGTH,
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE,
  MIN_SEARCH_LENGTH,
  TRACK_SORT_COLUMNS,
  type LibraryBrowseFilters,
  type ListFacetIdsQuery,
  type ListFacetsQuery,
  type ListTrackGroupsQuery,
  type ListTrackIdsQuery,
  type ListTracksQuery,
  type OrderTrackIdsQuery,
  type SortDirection,
  type TrackSortColumn
} from '@shared/library'
import {
  MAX_CROSSFADE_MS,
  MAX_PLAYLIST_BATCH,
  MAX_PLAYLIST_ENTRY_ID_PAGE,
  MAX_PLAYLIST_ENTRY_PAGE,
  MAX_PLAYLIST_NAME_LENGTH,
  type AddTracksToPlaylistRequest,
  type ListPlaylistEntriesQuery,
  type ListPlaylistEntryIdsQuery,
  type MovePlaylistEntriesRequest,
  type PlaylistInsertion,
  type RemovePlaylistEntriesRequest
} from '@shared/playlists'

/**
 * Request validation at the boundary.
 *
 * The renderer is our own code, so this is not primarily about a hostile
 * caller — it is about the two failure modes that actually happen: a bug
 * sending the wrong shape, and a compromised renderer probing the seam. Both
 * are cheaper to catch here than in a SQL query three layers down.
 */

function invalid(message: string): never {
  throw new FermataError('invalid-request', message)
}

function assertOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(raw).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) invalid(`Unexpected query field: ${unexpected[0]}.`)
}

export function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(`${field} must be a positive integer.`)
  }
  return value
}

export function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`)
  }
  return value as Record<string, unknown>
}

/**
 * A facet dimension: a non-empty, deduplicated set of positive ids.
 *
 * Empty is rejected rather than normalised to "no constraint". An empty array
 * reaching here means a caller cleared a selection and kept the field, and the
 * two readings of that — match nothing, match everything — differ by the whole
 * library. Better a loud `invalid-request` at the seam than the wrong one.
 *
 * Duplicates are dropped rather than refused: they change no result, and a
 * selection assembled from overlapping ranges can honestly contain them.
 */
function assertIdSet(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array of positive integers.`)
  if (value.length === 0) invalid(`${field} must not be empty.`)
  if (value.length > MAX_FILTER_IDS) invalid(`${field} must not exceed ${MAX_FILTER_IDS} ids.`)
  return [...new Set(value.map((id) => assertPositiveInt(id, `${field} entries`)))]
}

function assertBrowseFilters(raw: Record<string, unknown>): LibraryBrowseFilters {
  const filters: LibraryBrowseFilters = {}
  if (raw.rootId !== undefined) filters.rootId = assertPositiveInt(raw.rootId, 'rootId')
  for (const field of ['artistIds', 'albumIds'] as const) {
    if (raw[field] !== undefined) filters[field] = assertIdSet(raw[field], field)
  }

  if (raw.searchText !== undefined) {
    if (typeof raw.searchText !== 'string') invalid('searchText must be a string.')
    const searchText = raw.searchText.trim()
    const searchable = searchText
      .split(/\s+/u)
      .some((term) => [...term].length >= MIN_SEARCH_LENGTH)
    if (!searchable) {
      invalid(`searchText must contain a term of at least ${MIN_SEARCH_LENGTH} characters.`)
    }
    if ([...searchText].length > MAX_SEARCH_LENGTH) {
      invalid(`searchText must not exceed ${MAX_SEARCH_LENGTH} characters.`)
    }
    filters.searchText = searchText
  }
  return filters
}

function assertWindow(
  raw: Record<string, unknown>,
  maxPage: number
): Pick<ListFacetsQuery, 'offset' | 'limit'> {
  const offset = raw.offset
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    invalid('offset must be a non-negative integer.')
  }

  const limit = raw.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    invalid('limit must be a positive integer.')
  }
  if (limit > maxPage) invalid(`limit must not exceed ${maxPage}.`)
  return { offset, limit }
}

const FACET_QUERY_KEYS = [
  'rootId',
  'artistIds',
  'albumIds',
  'searchText',
  'offset',
  'limit'
] as const

export function assertListFacetsQuery(value: unknown): ListFacetsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, FACET_QUERY_KEYS)
  return { ...assertBrowseFilters(raw), ...assertWindow(raw, MAX_FACET_PAGE) }
}

/**
 * Same shape as a facet query, larger page ceiling — the id-page argument again,
 * one dimension over. The ceiling equals `MAX_FILTER_IDS` so that a range wide
 * enough to become a filter is always resolvable in a single call.
 */
export function assertListFacetIdsQuery(value: unknown): ListFacetIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, FACET_QUERY_KEYS)
  return { ...assertBrowseFilters(raw), ...assertWindow(raw, MAX_FACET_ID_PAGE) }
}

/**
 * Validates the ordering half of a track query.
 *
 * `sort` and `direction` are checked against closed allowlists rather than
 * merely typed, because both are interpolated into an ORDER BY clause in W2-1.
 * A type annotation is erased at runtime; this check is not.
 */
function assertOrdering(raw: Record<string, unknown>): {
  sort: TrackSortColumn
  direction: SortDirection
} {
  const sort = raw.sort
  if (typeof sort !== 'string' || !TRACK_SORT_COLUMNS.includes(sort as never)) {
    invalid(`sort must be one of: ${TRACK_SORT_COLUMNS.join(', ')}.`)
  }

  const direction = raw.direction
  if (direction !== 'asc' && direction !== 'desc') {
    invalid("direction must be 'asc' or 'desc'.")
  }

  return { sort: sort as TrackSortColumn, direction }
}

const TRACK_QUERY_KEYS = [
  'rootId',
  'artistIds',
  'albumIds',
  'searchText',
  'sort',
  'direction',
  'offset',
  'limit'
] as const

export function assertListTracksQuery(value: unknown): ListTracksQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, TRACK_QUERY_KEYS)
  return {
    ...assertBrowseFilters(raw),
    ...assertOrdering(raw),
    ...assertWindow(raw, MAX_TRACK_PAGE)
  }
}

/**
 * Same shape as a track query, larger page ceiling.
 *
 * The ceiling is the only difference and it is the whole point of the separate
 * channel: an id page carries integers rather than the display projection, so a
 * range selection can resolve ten thousand rows in one call without either side
 * pretending that is the same cost as ten thousand `Track` objects.
 */
export function assertListTrackIdsQuery(value: unknown): ListTrackIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, TRACK_QUERY_KEYS)
  return {
    ...assertBrowseFilters(raw),
    ...assertOrdering(raw),
    ...assertWindow(raw, MAX_TRACK_ID_PAGE)
  }
}

/**
 * Validates a request for the album runs behind a grouped list.
 *
 * Unpaged, so it carries the ordering and the filters but no window — the
 * renderer needs every run to size the list before it loads a row. The sort
 * column is validated the same way as any other list request; the store is what
 * rejects a non-album-major one, since that is a contract about the shape of
 * the list rather than about the shape of the message.
 */
export function assertListTrackGroupsQuery(value: unknown): ListTrackGroupsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['rootId', 'artistIds', 'albumIds', 'searchText', 'sort', 'direction'])
  return {
    ...assertBrowseFilters(raw),
    ...assertOrdering(raw)
  }
}

/**
 * Validates a request to order an arbitrary id set.
 *
 * Every element is checked rather than sampled: these ids reach a JSON array
 * that SQLite expands with `json_each`, and one non-integer in the middle of ten
 * thousand would surface as an empty or short result rather than as an error.
 */
export function assertOrderTrackIdsQuery(value: unknown): OrderTrackIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['sort', 'direction', 'ids'])

  const ids = raw.ids
  if (!Array.isArray(ids)) invalid('ids must be an array.')
  if (ids.length > MAX_ORDERED_TRACK_IDS) {
    invalid(`ids must not exceed ${MAX_ORDERED_TRACK_IDS} entries.`)
  }
  for (const id of ids) assertPositiveInt(id, 'ids entry')

  return { ...assertOrdering(raw), ids: ids as number[] }
}

/**
 * A playlist name the user could have typed.
 *
 * Trimmed and required to be non-empty, because a blank tab is unclickable and
 * indistinguishable from its neighbours — the failure is silent and the user
 * has no way back to the playlist. The length bound exists so a paste accident
 * cannot write a megabyte into a tab label.
 */
export function assertPlaylistName(value: unknown): string {
  if (typeof value !== 'string') invalid('name must be a string.')
  const name = value.trim()
  if (name.length === 0) invalid('name must not be empty.')
  if ([...name].length > MAX_PLAYLIST_NAME_LENGTH) {
    invalid(`name must not exceed ${MAX_PLAYLIST_NAME_LENGTH} characters.`)
  }
  return name
}

/** R2's per-playlist policy. Zero is meaningful — it is what "gapless" means. */
export function assertCrossfadeMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid('crossfadeMs must be a non-negative integer.')
  }
  if (value > MAX_CROSSFADE_MS) invalid(`crossfadeMs must not exceed ${MAX_CROSSFADE_MS}.`)
  return value
}

/**
 * An add or move anchor.
 *
 * The four cases are checked exhaustively rather than by `at` alone: a request
 * claiming `before` without an `entryId` would otherwise reach the store as a
 * lookup for `undefined`, which SQLite answers with no row and the store reads
 * as a deleted entry — a confusing `not-found` for what is a caller bug.
 */
function assertPlaylistInsertion(value: unknown): PlaylistInsertion {
  const raw = assertRecord(value, 'insertion')
  assertOnlyKeys(raw, ['at', 'entryId'])
  switch (raw.at) {
    case 'start':
    case 'end':
      if (raw.entryId !== undefined) invalid(`insertion.at '${raw.at}' takes no entryId.`)
      return { at: raw.at }
    case 'before':
    case 'after':
      return { at: raw.at, entryId: assertPositiveInt(raw.entryId, 'insertion.entryId') }
    default:
      return invalid('insertion.at must be one of: start, end, before, after.')
  }
}

/**
 * A batch of ids for an add, move or remove.
 *
 * Duplicates survive here, unlike in `assertIdSet`. For a filter they are
 * noise; for an add they are intent — D12 makes the same track legal twice, and
 * dropping them would quietly turn "add these two copies" into "add one".
 */
function assertPlaylistIdBatch(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array of positive integers.`)
  if (value.length === 0) invalid(`${field} must not be empty.`)
  if (value.length > MAX_PLAYLIST_BATCH) {
    invalid(`${field} must not exceed ${MAX_PLAYLIST_BATCH} ids.`)
  }
  return value.map((id) => assertPositiveInt(id, `${field} entries`))
}

function assertEntriesQuery(value: unknown, maxPage: number): ListPlaylistEntriesQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['playlistId', 'offset', 'limit'])
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    ...assertWindow(raw, maxPage)
  }
}

export function assertListPlaylistEntriesQuery(value: unknown): ListPlaylistEntriesQuery {
  return assertEntriesQuery(value, MAX_PLAYLIST_ENTRY_PAGE)
}

/** The same window, ids only, at ten times the page ceiling — see the library pair. */
export function assertListPlaylistEntryIdsQuery(value: unknown): ListPlaylistEntryIdsQuery {
  return assertEntriesQuery(value, MAX_PLAYLIST_ENTRY_ID_PAGE)
}

export function assertAddTracksRequest(value: unknown): AddTracksToPlaylistRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId', 'trackIds', 'insertion'])
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    trackIds: assertPlaylistIdBatch(raw.trackIds, 'trackIds'),
    insertion: assertPlaylistInsertion(raw.insertion)
  }
}

export function assertMoveEntriesRequest(value: unknown): MovePlaylistEntriesRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId', 'entryIds', 'insertion'])
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    entryIds: assertPlaylistIdBatch(raw.entryIds, 'entryIds'),
    insertion: assertPlaylistInsertion(raw.insertion)
  }
}

export function assertRemoveEntriesRequest(value: unknown): RemovePlaylistEntriesRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId', 'entryIds'])
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    entryIds: assertPlaylistIdBatch(raw.entryIds, 'entryIds')
  }
}

/** Tab order. Zero is a valid destination, so this is not `assertPositiveInt`. */
export function assertTabIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid('toIndex must be a non-negative integer.')
  }
  return value
}
