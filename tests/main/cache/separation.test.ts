/**
 * The half of W7-8 that is about what the cache is *not* part of.
 *
 * D14 excludes `cache.db` from D11's export bundle, and the card asks that this
 * be provable rather than remembered. The exporter itself has not been built
 * yet, so what is proved here is everything that will still be true when it is:
 * that the exclusion is declared where an exporter has to read it, and that the
 * two databases share nothing an exporter could pick the cache up *through* —
 * no table name in common, no reference in either direction, and no ATTACH to
 * join them into one file.
 *
 * The file-level assertion — "this bundle does not contain this file" — lands
 * with the bundle. These are the invariants that make writing it correctly
 * possible, and the ones whose quiet violation would make it wrong.
 */

import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import {
  CACHE_DATABASE_ARTIFACT,
  EXPORT_EXCLUDED_ARTIFACTS,
  LIBRARY_DATABASE_ARTIFACT,
  USER_DATA_ARTIFACTS
} from '../../../src/main/db/artifacts'
import { MIGRATIONS } from '../../../src/main/db/migrations'
import { migrate } from '../../../src/main/db/migrate'
import type { Migration } from '../../../src/main/db/migrate'

const MAIN_SOURCE = join(__dirname, '../../../src/main')

const open: Database.Database[] = []

afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

/** Every object a registry creates, as SQLite records it. */
function schemaOf(migrations: readonly Migration[]): { tables: string[]; indexes: string[] } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  open.push(db)
  migrate(db, migrations)

  const rows = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { type: string; name: string }[]

  return {
    tables: rows.filter((row) => row.type === 'table').map((row) => row.name),
    indexes: rows.filter((row) => row.type === 'index').map((row) => row.name)
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('cache.db is separate from library.db', () => {
  it('shares no table or index name with the library schema', () => {
    // The property that lets an exporter dump the library by table name without
    // ever being able to reach a cached reply: there is no name in common to
    // reach it through.
    const library = schemaOf(MIGRATIONS)
    const cache = schemaOf(CACHE_MIGRATIONS)

    expect(cache.tables).toEqual(['cache_entries'])
    expect(library.tables).not.toContain('cache_entries')
    expect(cache.tables.filter((name) => library.tables.includes(name))).toEqual([])
    expect(cache.indexes.filter((name) => library.indexes.includes(name))).toEqual([])
  })

  it('has its own version counter, so a schema step here costs the library nothing', () => {
    const cache = new Database(':memory:')
    open.push(cache)
    const library = new Database(':memory:')
    open.push(library)

    migrate(cache, CACHE_MIGRATIONS)
    migrate(library, MIGRATIONS)

    expect(cache.pragma('user_version', { simple: true })).toBe(CACHE_MIGRATIONS.length)
    expect(library.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(CACHE_MIGRATIONS.length).not.toBe(MIGRATIONS.length)
  })

  it('carries no foreign key in either direction', () => {
    // A cross-file reference is not expressible without an ATTACH, so a schema
    // that grew one would be a schema that had quietly stopped being separate.
    const cache = new Database(':memory:')
    open.push(cache)
    migrate(cache, CACHE_MIGRATIONS)

    for (const { name } of cache
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as {
      name: string
    }[]) {
      expect(cache.pragma(`foreign_key_list(${name})`)).toEqual([])
    }
  })

  it('is never ATTACHed to another database anywhere in main', () => {
    const offenders = sourceFiles(MAIN_SOURCE).filter((path) =>
      // `ATTACH DATABASE`, `ATTACH '/path'` and `ATTACH ?` all count. The
      // alternation is what keeps the word in a docblock from being a finding.
      /\bATTACH\s+(DATABASE\b|['"?$:@])/i.test(readFileSync(path, 'utf8'))
    )

    expect(offenders).toEqual([])
  })
})

describe('D11 exclusion', () => {
  it('declares the cache as derived and excludes it from the export bundle', () => {
    expect(CACHE_DATABASE_ARTIFACT).toMatchObject({ name: 'cache.db', kind: 'derived' })
    expect(EXPORT_EXCLUDED_ARTIFACTS).toContain('cache.db')
  })

  it('does not exclude the library, which is what the bundle is about', () => {
    expect(LIBRARY_DATABASE_ARTIFACT.kind).toBe('authored')
    expect(EXPORT_EXCLUDED_ARTIFACTS).not.toContain(LIBRARY_DATABASE_ARTIFACT.name)
  })

  it('gives every artifact a distinct name and a stated reason', () => {
    const names = USER_DATA_ARTIFACTS.map((artifact) => artifact.name)
    expect(new Set(names).size).toBe(names.length)
    for (const artifact of USER_DATA_ARTIFACTS) {
      expect(artifact.why.length).toBeGreaterThan(0)
    }
  })
})
