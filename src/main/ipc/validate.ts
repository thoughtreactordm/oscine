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
