import { FermataError } from '@shared/errors'
import { MAX_TRACK_PAGE, TRACK_SORT_COLUMNS, type ListTracksQuery } from '@shared/library'

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
 * Validates a track query.
 *
 * `sort` and `direction` are checked against closed allowlists rather than
 * merely typed, because both are interpolated into an ORDER BY clause in W2-1.
 * A type annotation is erased at runtime; this check is not.
 */
export function assertListTracksQuery(value: unknown): ListTracksQuery {
  const raw = assertRecord(value, 'query')

  const sort = raw.sort
  if (typeof sort !== 'string' || !TRACK_SORT_COLUMNS.includes(sort as never)) {
    invalid(`sort must be one of: ${TRACK_SORT_COLUMNS.join(', ')}.`)
  }

  const direction = raw.direction
  if (direction !== 'asc' && direction !== 'desc') {
    invalid("direction must be 'asc' or 'desc'.")
  }

  const offset = raw.offset
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    invalid('offset must be a non-negative integer.')
  }

  const limit = raw.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    invalid('limit must be a positive integer.')
  }
  if (limit > MAX_TRACK_PAGE) {
    invalid(`limit must not exceed ${MAX_TRACK_PAGE}.`)
  }

  let rootId: number | undefined
  if (raw.rootId !== undefined) {
    rootId = assertPositiveInt(raw.rootId, 'rootId')
  }

  return {
    sort: sort as ListTracksQuery['sort'],
    direction,
    offset,
    limit,
    ...(rootId === undefined ? {} : { rootId })
  }
}
