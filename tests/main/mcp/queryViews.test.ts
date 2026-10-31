import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { MCP_VIEWS } from '../../../src/main/mcp/query/views'
import { deriveReadPolicy, MCP_VIEW_NAME } from '../../../src/main/mcp/sqlConfinement'

/**
 * The `mcp_*` views are a public contract (D36.4), and `describe_views` is how
 * an agent learns it. These hold the documentation to the schema, and the
 * schema to the review rule: no view reads `settings` or an absolute path.
 */
describe('mcp_* views', () => {
  let dir: string
  let opened: OpenDatabaseResult

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-mcp-views-'))
    opened = openDatabase(join(dir, 'library.db'))
  })

  afterAll(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('describe_views documents exactly the views the schema holds', () => {
    const live = (
      opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as {
        name: string
      }[]
    )
      .map((row) => row.name)
      .filter((name) => MCP_VIEW_NAME.test(name))
      .sort()
    expect(MCP_VIEWS.map((view) => view.name).sort()).toEqual(live)
  })

  it.each(MCP_VIEWS.map((view) => [view.name, view] as const))(
    '%s: documented columns are the live columns, in order',
    (name, view) => {
      const live = (opened.db.pragma(`table_info(${name})`) as { name: string }[]).map(
        (column) => column.name
      )
      expect(view.columns.map((column) => column.name)).toEqual(live)
      for (const column of view.columns) expect(column.description.length).toBeGreaterThan(0)
    }
  )

  /**
   * The review rule for every view migration, W24-5 first (D36.4): whatever a
   * view reads, an agent can read. So no view may touch `settings`, the root
   * path, or any credential-bearing table — anywhere, not just its select list.
   */
  it('reads nothing an agent must not have', () => {
    const db = new DatabaseSync(join(dir, 'library.db'), { readOnly: true })
    try {
      const { columns, tables } = deriveReadPolicy(db)
      expect(tables.has('settings')).toBe(false)
      expect(columns.has('roots\u0000path')).toBe(false)
      for (const table of tables) {
        expect(table, table).not.toMatch(/scrobble|credential|token|secret|session|outbox/i)
      }
    } finally {
      db.close()
    }
  })
})
