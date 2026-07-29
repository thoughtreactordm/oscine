import { FermataError } from '@shared/errors'
import {
  MAX_FACET_PAGE,
  MAX_SEARCH_LENGTH,
  MAX_TRACK_PAGE,
  MIN_SEARCH_LENGTH,
  TRACK_SORT_COLUMNS,
  type LibraryBrowseFilters,
  type ListFacetsQuery,
  type ListTracksQuery
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

function assertBrowseFilters(raw: Record<string, unknown>): LibraryBrowseFilters {
  const filters: LibraryBrowseFilters = {}
  for (const field of ['rootId', 'artistId', 'albumId'] as const) {
    if (raw[field] !== undefined) filters[field] = assertPositiveInt(raw[field], field)
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

export function assertListFacetsQuery(value: unknown): ListFacetsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['rootId', 'artistId', 'albumId', 'searchText', 'offset', 'limit'])
  return { ...assertBrowseFilters(raw), ...assertWindow(raw, MAX_FACET_PAGE) }
}

/**
 * Validates a track query.
 *
 * `sort` and `direction` are checked against closed allowlists rather than
 * merely typed, because both are interpolated into an ORDER BY clause in W2-1.
 * A type annotation is erased at runtime; this check is not.
 */
export function assertListTracksQuery(value: unknown): ListTracksQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, [
    'rootId',
    'artistId',
    'albumId',
    'searchText',
    'sort',
    'direction',
    'offset',
    'limit'
  ])

  const sort = raw.sort
  if (typeof sort !== 'string' || !TRACK_SORT_COLUMNS.includes(sort as never)) {
    invalid(`sort must be one of: ${TRACK_SORT_COLUMNS.join(', ')}.`)
  }

  const direction = raw.direction
  if (direction !== 'asc' && direction !== 'desc') {
    invalid("direction must be 'asc' or 'desc'.")
  }

  return {
    ...assertBrowseFilters(raw),
    sort: sort as ListTracksQuery['sort'],
    direction,
    ...assertWindow(raw, MAX_TRACK_PAGE)
  }
}
