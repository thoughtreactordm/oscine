/**
 * The `settings` table, and nothing else.
 *
 * No registry, no defaults, no validation: this layer moves rows and parses
 * JSON. Everything that decides what a value *means* lives in the service above
 * it, which is what lets the resolution logic be tested without a database and
 * the SQL be tested without the registry.
 */

import type BetterSqlite3 from 'better-sqlite3'
import type {
  SettingEntityKind,
  SettingNotice,
  SettingScopeRef,
  StoredSetting
} from '@shared/settings'

interface SettingRow {
  key: string
  value: string
  version: number
}

/**
 * One entity-scoped row for a key: which entity it sits at, and its value.
 *
 * The scope is an entity, never global — the query that produces these excludes
 * the global row — so its id is a number, and its kind is narrowed accordingly
 * for the service that filters these against a descriptor's cascade.
 */
export interface KeyScopeRead {
  scope: { kind: SettingEntityKind; id: number }
  stored: StoredSetting
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
   * One key at one scope, or null when there is no row.
   *
   * The point lookup a cascade walks. It serves the primary key directly, so
   * resolving a three-level cascade is two indexed reads rather than a scan —
   * which is what lets `resolve` be called per boundary without a cache in front
   * of it.
   *
   * A row whose JSON will not parse comes back as null rather than throwing: a
   * damaged override should fall through to the next level, and that decision
   * belongs to `resolveCascade`, which cannot make it if this layer raises.
   */
  readKey(key: string, scope: SettingScopeRef): StoredSetting | null {
    const row = this.db
      .prepare<[string, string, number | null], Omit<SettingRow, 'key'>>(
        'SELECT value, version FROM settings WHERE key = ? AND scope_kind = ? AND scope_id IS ?'
      )
      .get(key, scope.kind, scope.id)
    if (row === undefined) return null

    try {
      return { value: JSON.parse(row.value) as unknown, version: row.version }
    } catch {
      return null
    }
  }

  /**
   * Every entity-scoped row for one key, across all scopes; the global row is
   * excluded on purpose.
   *
   * The inverse of the point lookup `readKey` does: not "what does this scope
   * hold" but "which scopes hold this key". It backs the assignments list — the
   * one question the cascade never asks at play time, because a boundary resolves
   * one entity and never enumerates them all, and so the one the store has to be
   * asked directly. Served by the `settings_scope`-adjacent path rather than a
   * key index, so it is a small scan of the overrides, not of the table.
   *
   * A row whose JSON will not parse is reported as malformed rather than dropped
   * silently, the way `readScope` does it: an assignment the operator made and
   * cannot see would be worse than one they can see is broken.
   */
  readKeyScopes(key: string): { rows: KeyScopeRead[]; malformed: SettingNotice[] } {
    const raw = this.db
      .prepare<
        [string],
        { scope_kind: string; scope_id: number | null; value: string; version: number }
      >(
        'SELECT scope_kind, scope_id, value, version FROM settings ' +
          "WHERE key = ? AND scope_kind != 'global'"
      )
      .all(key)

    const rows: KeyScopeRead[] = []
    const malformed: SettingNotice[] = []

    for (const row of raw) {
      try {
        rows.push({
          scope: { kind: row.scope_kind as SettingEntityKind, id: row.scope_id as number },
          stored: { value: JSON.parse(row.value) as unknown, version: row.version }
        })
      } catch (error) {
        malformed.push({
          key,
          reason: `stored value is not valid JSON: ${(error as Error).message}`,
          rejected: row.value
        })
      }
    }

    return { rows, malformed }
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
