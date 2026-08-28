import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GenreValue } from '@shared/tagWriteback'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { GenreAliasStore } from '../../../src/main/genre/canonicalize'

/**
 * `genre_aliases` and its store — W16-5, migration 020.
 *
 * Driven through the real migration list against a real SQLite file, like the
 * tags and favorites stores and for the same reason: the load-bearing claims —
 * that both sides of a rule land on the shared casefold key, that a rule
 * repoints rather than duplicates, and that `canonicalizer()` reads the durable
 * rows — are properties of what is actually in the database.
 */

let dir: string
let opened: OpenDatabaseResult
let db: Database.Database
let store: GenreAliasStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-genre-aliases-'))
  opened = openDatabase(join(dir, 'library.db'))
  db = opened.db
  store = new GenreAliasStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function rowCount(): number {
  return (db.prepare('SELECT count(*) AS n FROM genre_aliases').get() as { n: number }).n
}

function gv(key: string, label: string): GenreValue {
  return { key, label }
}

describe('setAlias', () => {
  it('coins a rule, keying both sides on the shared casefold', () => {
    const rule = store.setAlias('HIP-HOP', 'Hip Hop')

    expect(rule).toEqual({
      aliasKey: 'hip-hop',
      canonicalKey: 'hip hop',
      canonicalLabel: 'Hip Hop'
    })
    expect(rowCount()).toBe(1)
  })

  it('keeps the canonical spelling as entered while folding on the key', () => {
    store.setAlias('rap', '  Hip-Hop  ')

    expect(store.listAliases()).toEqual([
      { aliasKey: 'rap', canonicalKey: 'hip-hop', canonicalLabel: 'Hip-Hop' }
    ])
  })

  it('returns null when either side normalises to nothing', () => {
    expect(store.setAlias('   ', 'Hip-Hop')).toBeNull()
    expect(store.setAlias('rap', '')).toBeNull()
    expect(rowCount()).toBe(0)
  })

  it('refuses a rule whose two sides share a key — a genre is not its own alias', () => {
    expect(store.setAlias('Hip-Hop', 'hip-hop')).toBeNull()
    expect(rowCount()).toBe(0)
  })

  it('repoints an existing variant rather than duplicating it', () => {
    store.setAlias('rap', 'Hip-Hop')
    store.setAlias('RAP', 'Rap & Hip-Hop')

    expect(store.listAliases()).toEqual([
      { aliasKey: 'rap', canonicalKey: 'rap & hip-hop', canonicalLabel: 'Rap & Hip-Hop' }
    ])
    expect(rowCount()).toBe(1)
  })
})

describe('removeAlias', () => {
  it('deletes the rule keyed by any spelling of the variant', () => {
    store.setAlias('rap', 'Hip-Hop')

    expect(store.removeAlias('RAP')).toBe(true)
    expect(rowCount()).toBe(0)
  })

  it('is idempotent on a variant that carries no rule', () => {
    expect(store.removeAlias('rap')).toBe(false)
  })
})

describe('listAliases', () => {
  it('groups variants under their canonical spelling, then by alias key', () => {
    store.setAlias('rap', 'Hip-Hop')
    store.setAlias('alt', 'Alternative')
    store.setAlias('hiphop', 'Hip-Hop')

    expect(store.listAliases().map((r) => r.aliasKey)).toEqual(['alt', 'hiphop', 'rap'])
  })
})

describe('canonicalizer', () => {
  it('folds a genre set from the durable rules', () => {
    store.setAlias('hiphop', 'Hip-Hop')
    store.setAlias('rap', 'Hip-Hop')

    const canon = store.canonicalizer()

    expect(canon([gv('hiphop', 'hiphop'), gv('rap', 'Rap'), gv('rock', 'Rock')])).toEqual([
      gv('hip-hop', 'Hip-Hop'),
      gv('rock', 'Rock')
    ])
  })

  it('is identity over an empty rule set', () => {
    const set = [gv('rock', 'Rock')]
    expect(store.canonicalizer()(set)).toBe(set)
  })
})
