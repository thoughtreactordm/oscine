import type { DatabaseSync } from 'node:sqlite'
import { MAX_CELL_CHARS, type QueryCell, type QueryResult } from './protocol'
import { singleStatement } from './statement'

/**
 * Runs one agent statement on the confined connection — **W24-5**,
 * `oscine-mcp` → D36.4. Called in the query process; it never sees the main
 * connection.
 *
 * The order is the defence, cheapest refusal first:
 *
 * 1. **One statement** — a tail is refused before SQLite sees anything.
 * 2. **Prepare under the authorizer** — anything outside the `mcp_*` views'
 *    allowlist, any `PRAGMA`, `ATTACH`, write or DDL fails here, before a row is
 *    read (`sqlConfinement.ts`).
 * 3. **Must be a reader** — a statement with no result columns is refused
 *    without being stepped. This is better-sqlite3's `Statement.reader`, which
 *    `node:sqlite` spells `columns().length > 0`. It is what stops `VACUUM INTO`,
 *    which the authorizer has no action code for and which `query_only` allows
 *    because it writes a *new* file.
 * 4. **Row cap** — rows are stepped one at a time and the cap + 1th ends it, so
 *    a huge result is never materialised.
 *
 * The wall-clock deadline is not here: a step inside SQLite cannot be interrupted
 * from JavaScript, so the host kills the whole process (`host.ts`).
 */
export function runQuery(db: DatabaseSync, input: string, rowCap: number): QueryResult {
  const started = performance.now()
  const shape = singleStatement(input)
  if (!shape.ok) {
    return shape.reason === 'empty'
      ? { ok: false, refusal: 'empty', message: 'The query is empty.' }
      : {
          ok: false,
          refusal: 'multiple',
          message: 'Send one statement per call; everything after the first `;` was refused.'
        }
  }

  let statement: ReturnType<DatabaseSync['prepare']>
  try {
    statement = db.prepare(shape.sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return /not authorized|prohibited|readonly|attempt to write/i.test(message)
      ? {
          ok: false,
          refusal: 'not-authorized',
          message:
            'Refused: only SELECT over the mcp_* views (call describe_views) is allowed. ' +
            'Base tables, settings, the schema table, PRAGMA, ATTACH and every write are ' +
            `not readable or runnable. (${message})`
        }
      : { ok: false, refusal: 'sql-error', message }
  }

  const columns = statement.columns().map((column) => column.name)
  if (columns.length === 0) {
    return {
      ok: false,
      refusal: 'not-reader',
      message: 'Refused: the statement returns no rows. Only queries that read are allowed.'
    }
  }

  statement.setReadBigInts(true)
  statement.setReturnArrays(true)
  const rows: QueryCell[][] = []
  let truncated = false
  let clippedCells = 0
  try {
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      if (rows.length === rowCap) {
        truncated = true
        break
      }
      rows.push(
        row.map((value) => {
          const cell = toCell(value)
          if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
            clippedCells += 1
            return `${cell.slice(0, MAX_CELL_CHARS)}…`
          }
          return cell
        })
      )
    }
  } catch (error) {
    return {
      ok: false,
      refusal: 'sql-error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
  return {
    ok: true,
    columns,
    rows,
    truncated,
    clippedCells,
    elapsedMs: Math.round(performance.now() - started)
  }
}

/** JSON-safe: an integer past 2^53 stays exact as text, and a blob is described, not sent. */
function toCell(value: unknown): QueryCell {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  if (value instanceof Uint8Array) return `<blob: ${value.byteLength} bytes>`
  return String(value)
}
