import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import {
  BUNDLE_TABLES,
  CARRIED_TABLES,
  EXCLUDED_TABLES,
  bundleTable
} from '../../../src/main/bundle/tables'

/**
 * The D11 table contract, asserted against the schema rather than against itself.
 *
 * This is `artifacts.test.ts`'s argument one level down: a declaration nobody
 * checks is a comment. The assertion that earns this file is the first one — the
 * declared set and `sqlite_master` are the same set — because it is the one that
 * fails on a migration nobody thought about, which is the only case where a
 * reviewer's memory was going to be the control.
 */

let dir: string
let file: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-test-'))
  file = join(dir, 'library.db')
  db = openDatabase(file).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Every table an operator's database actually contains, minus the ones nobody
 * declares: SQLite's own, and the shadow tables FTS5 creates under its virtual
 * table's name. The shadow filter is derived from the virtual tables present
 * rather than hardcoded to `tracks_fts_`, so a second FTS table would not need
 * this helper edited before the suite told the truth again.
 */
function schemaTables(): string[] {
  const rows = db
    .prepare("SELECT name AS name, sql AS sql FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string; sql: string | null }[]

  const virtual = rows
    .filter((row) => row.sql?.toUpperCase().startsWith('CREATE VIRTUAL TABLE'))
    .map((row) => row.name)

  return rows
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'))
    .filter((name) => !virtual.some((vt) => name.startsWith(`${vt}_`)))
    .sort()
}

describe('the D11 table contract', () => {
  it('declares a side for every table in the schema, and no table that is not', () => {
    const declared = BUNDLE_TABLES.map((table) => table.name).sort()
    expect(declared).toEqual(schemaTables())
  })

  it('declares each table exactly once', () => {
    const names = BUNDLE_TABLES.map((table) => table.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every carried table a merge rule, and nothing else one', () => {
    for (const table of BUNDLE_TABLES) {
      if (table.side === 'carried') expect(table.merge, table.name).toBeTruthy()
      else expect(table.merge, table.name).toBeUndefined()
    }
  })

  it('says why, for every table', () => {
    for (const table of BUNDLE_TABLES) expect(table.why.length, table.name).toBeGreaterThan(0)
  })

  it('carries the listens log, its genres and favorites', () => {
    expect(CARRIED_TABLES).toEqual(
      expect.arrayContaining(['listens', 'listen_genres', 'track_favorites'])
    )
  })

  /**
   * The named regression. `play_history` gained a neighbour that is carried, and
   * the whole of W10-13's card is that this changes nothing about the trail.
   */
  it('still excludes the play-history trail, the outbox and the derived genres', () => {
    expect(EXCLUDED_TABLES).toEqual(
      expect.arrayContaining(['play_history', 'scrobble_queue', 'track_genres'])
    )
  })

  it('carries only three columns of tracks', () => {
    expect(bundleTable('tracks')?.columns).toEqual(['rating', 'play_count', 'last_played_at'])
  })

  it('leaves open tables out of both lists, so an exporter finds the question', () => {
    const open = BUNDLE_TABLES.filter((table) => table.side === 'open').map((table) => table.name)
    expect(open.length).toBeGreaterThan(0)
    for (const name of open) {
      expect(CARRIED_TABLES).not.toContain(name)
      expect(EXCLUDED_TABLES).not.toContain(name)
    }
  })
})
