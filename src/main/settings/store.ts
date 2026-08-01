/**
 * The `settings` table, and nothing else.
 *
 * No registry, no defaults, no validation: this layer moves rows and parses
 * JSON. Everything that decides what a value *means* lives in the service above
 * it, which is what lets the resolution logic be tested without a database and
 * the SQL be tested without the registry.
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { SettingNotice, SettingScopeRef, StoredSetting } from '@shared/settings'

interface SettingRow {
  key: string
  value: string
  version: number
}

/** What one scope's rows resolved to, plus the ones that were unreadable. */
export interface ScopeRead {
  stored: Record<string, StoredSetting>
  /**
   * Rows whose `value` was not JSON.
   *
   * Reported rather than coerced. Handing a corrupt blob to a string key's
   * validator would let it through as an ordinary string, and the operator would
   * never learn the row was damaged.
   */
  malformed: SettingNotice[]
}

export interface WriteEntry {
  key: string
  scope: SettingScopeRef
  value: unknown
  version: number
}

export class SettingsStore {
  private readonly db: BetterSqlite3.Database

  constructor(db: BetterSqlite3.Database) {
    this.db = db
  }

  /** Every row at one scope, JSON already parsed. */
  readScope(scope: SettingScopeRef): ScopeRead {
    const rows = this.db
      .prepare<[string, number | null], SettingRow>(
        // `IS` rather than `=`: the global scope's id is null, and `= NULL` is
        // never true. Every predicate in this file matches a scope this way.
        'SELECT key, value, version FROM settings WHERE scope_kind = ? AND scope_id IS ?'
      )
      .all(scope.kind, scope.id)

    const stored: Record<string, StoredSetting> = {}
    const malformed: SettingNotice[] = []

    for (const row of rows) {
      try {
        stored[row.key] = { value: JSON.parse(row.value) as unknown, version: row.version }
      } catch (error) {
        malformed.push({
          key: row.key,
          reason: `stored value is not valid JSON: ${(error as Error).message}`,
          rejected: row.value
        })
      }
    }

    return { stored, malformed }
  }

  /**
   * Insert or replace, as one transaction.
   *
   * Delete-then-insert rather than `ON CONFLICT`, because the conflict target
   * that actually constrains a global row is the `COALESCE(scope_id, -1)`
   * expression index rather than the declared primary key, and naming an
   * expression in a conflict target is a good deal less obvious than this is.
   */
  put(entries: readonly WriteEntry[], updatedAt: number): void {
    const remove = this.db.prepare(
      'DELETE FROM settings WHERE key = ? AND scope_kind = ? AND scope_id IS ?'
    )
    const insert = this.db.prepare(
      'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    )

    this.db.transaction(() => {
      for (const entry of entries) {
        remove.run(entry.key, entry.scope.kind, entry.scope.id)
        insert.run(
          entry.key,
          entry.scope.kind,
          entry.scope.id,
          JSON.stringify(entry.value),
          entry.version,
          updatedAt
        )
      }
    })()
  }

  /** Deletes one key at one scope. Returns whether a row was actually there. */
  remove(key: string, scope: SettingScopeRef): boolean {
    const result = this.db
      .prepare('DELETE FROM settings WHERE key = ? AND scope_kind = ? AND scope_id IS ?')
      .run(key, scope.kind, scope.id)
    return result.changes > 0
  }

  /** Deletes several keys at one scope. Returns the keys that had a row. */
  removeMany(keys: readonly string[], scope: SettingScopeRef): string[] {
    const statement = this.db.prepare(
      'DELETE FROM settings WHERE key = ? AND scope_kind = ? AND scope_id IS ?'
    )
    const removed: string[] = []

    this.db.transaction(() => {
      for (const key of keys) {
        if (statement.run(key, scope.kind, scope.id).changes > 0) removed.push(key)
      }
    })()

    return removed
  }
}
