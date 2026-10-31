import { constants, DatabaseSync } from 'node:sqlite'

/**
 * How `query_library` keeps `settings` and every other base table out of an
 * agent's SQL — **W24-1's finding**, `oscine-mcp` → D36.4. W24-5 builds the
 * worker, the timeout and the row cap on this; the mechanism is settled here.
 *
 * better-sqlite3 exposes no authorizer (`sqlite3_set_authorizer`), so the
 * worker's connection is a `node:sqlite` `DatabaseSync` instead: built into
 * Electron's Node (24.10+ has `setAuthorizer`), opened `readOnly`, on the same
 * WAL file the main connection writes. The authorizer runs at *prepare* time,
 * after views are expanded, so it sees every table a statement would touch —
 * including through a subquery, a CTE or a join — and a denial fails the
 * prepare before a row is read.
 *
 * The rule is a **column allowlist derived from the views themselves**. At
 * open, before the authorizer is installed, each `mcp_*` view is prepared once
 * with a recording authorizer; every `(table, column)` pair it reads — base
 * columns and the view's own — becomes readable, and nothing else is. So
 * `settings`, `sqlite_schema`, the pragma table functions and every base column
 * no view selects are unreadable however a statement reaches them, and a table
 * a later migration adds is closed by default.
 *
 * Why not "allow reads that happen inside an `mcp_*` view" (the authorizer's
 * fifth argument)? The W24-1 prototype showed SQLite fills that argument with a
 * **CTE's** name exactly as it does a view's: `WITH mcp_tracks AS (SELECT * FROM
 * settings) SELECT * FROM mcp_tracks` reports `settings` reads "inside
 * mcp_tracks". A rule on the name is a rule a query can satisfy by naming.
 *
 * The review rule this leaves W24-5 and every later view migration: **an
 * `mcp_*` view must not touch a credential or configuration column anywhere —
 * select list, join or WHERE**, because whatever a view reads is readable.
 */
export const MCP_VIEW_NAME = /^mcp_[a-z0-9_]+$/

const ALLOWED_ACTIONS: ReadonlySet<number> = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_RECURSIVE
])

/** Functions an agent's query may not call even on an allowed row. */
const DENIED_FUNCTIONS: ReadonlySet<string> = new Set(['load_extension'])

type Authorizer = (
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  triggerOrView: string | null
) => number

const columnKey = (table: string, column: string): string => `${table}\u0000${column}`

/** What a confined connection may read, fixed when it opens. */
export interface McpReadPolicy {
  /** `(table, column)` pairs some `mcp_*` view reads. */
  columns: ReadonlySet<string>
  /** Tables (and views) with at least one readable column. */
  tables: ReadonlySet<string>
  /** Every name in the schema — what a CTE or subquery alias is *not*. */
  schemaObjects: ReadonlySet<string>
}

/**
 * A read with no column is SQLite's table-level read — `COUNT(*)`, a `rowid`
 * scan, a recursive CTE stepping itself — and arrives with no database name,
 * so a CTE and a real table look alike. It is allowed for a table that already
 * has a readable column, or for a name the schema does not hold (a CTE or a
 * subquery). A CTE that borrows a schema name is refused: harmless, and the only
 * way to keep `SELECT COUNT(*) FROM settings` from answering.
 */
function isSchemaObject(policy: McpReadPolicy, name: string): boolean {
  return policy.schemaObjects.has(name) || /^(sqlite|pragma)_/i.test(name)
}

export function createMcpQueryAuthorizer(policy: McpReadPolicy): Authorizer {
  return (actionCode, arg1, arg2, dbName) => {
    if (ALLOWED_ACTIONS.has(actionCode)) return constants.SQLITE_OK
    if (actionCode === constants.SQLITE_READ) {
      if (arg1 === null) return constants.SQLITE_DENY
      const ok =
        arg2 === null || arg2 === ''
          ? policy.tables.has(arg1) || !isSchemaObject(policy, arg1)
          : dbName === 'main' && policy.columns.has(columnKey(arg1, arg2))
      return ok ? constants.SQLITE_OK : constants.SQLITE_DENY
    }
    if (actionCode === constants.SQLITE_FUNCTION) {
      // For SQLITE_FUNCTION, arg2 is the function name (arg1 is unused).
      return arg2 !== null && DENIED_FUNCTIONS.has(arg2.toLowerCase())
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK
    }
    // PRAGMA, ATTACH, every write and every DDL — a TEMP view included.
    return constants.SQLITE_DENY
  }
}

/** Walks the database's `mcp_*` views and records everything they read. */
export function deriveReadPolicy(db: DatabaseSync): McpReadPolicy {
  const objects = db.prepare('SELECT name, type FROM sqlite_schema').all() as {
    name: string
    type: string
  }[]
  const columns = new Set<string>()
  const tables = new Set<string>()
  db.setAuthorizer((actionCode, table, column) => {
    if (actionCode === constants.SQLITE_READ && table !== null && column) {
      columns.add(columnKey(table, column))
      tables.add(table)
    }
    return constants.SQLITE_OK
  })
  try {
    for (const { name, type } of objects) {
      if (type === 'view' && MCP_VIEW_NAME.test(name)) db.prepare(`SELECT * FROM "${name}"`)
    }
  } finally {
    db.setAuthorizer(null)
  }
  return { columns, tables, schemaObjects: new Set(objects.map((object) => object.name)) }
}

/**
 * Opens the confined connection. `query_only` is set and the views are walked
 * before the authorizer is installed, because it refuses both afterwards. The
 * allowlist is fixed for the connection's life; a migration that changes a view
 * runs at startup, before any worker opens one.
 */
export function openConfinedConnection(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: false })
  db.exec('PRAGMA query_only = ON')
  db.setAuthorizer(createMcpQueryAuthorizer(deriveReadPolicy(db)))
  return db
}
