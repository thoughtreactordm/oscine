import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCacheDatabase } from '../../../src/main/cache/open'
import { openCacheService } from '../../../src/main/cache/service'

const dirs: string[] = []

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oscine-cache-'))
  dirs.push(dir)
  return join(dir, 'cache.db')
}

/** Writes an entry through a throwaway connection and closes it. */
function seed(filePath: string): void {
  const { db } = openCacheDatabase(filePath)
  db.prepare(
    'INSERT INTO cache_entries (entity, key, payload, size_bytes, stored_at, expires_at, used_at) ' +
      "VALUES ('wikipedia.extract', 'k', '\"prose\"', 10, 1, 2, 1)"
  ).run()
  db.close()
}

function entryCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM cache_entries').get() as { n: number }).n
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('openCacheDatabase', () => {
  it('creates and migrates a cache that does not exist yet', () => {
    const filePath = cachePath()

    const { db, migration, rebuilt } = openCacheDatabase(filePath)
    try {
      expect(migration).toMatchObject({ from: 0, to: 1 })
      expect(rebuilt).toBe(false)
      expect(entryCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('reopens an existing cache without touching what is in it', () => {
    const filePath = cachePath()
    seed(filePath)

    const { db, migration, rebuilt } = openCacheDatabase(filePath)
    try {
      expect(migration.applied).toEqual([])
      expect(rebuilt).toBe(false)
      expect(entryCount(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('configures incremental auto-vacuum, so the size cap bounds the file too', () => {
    const filePath = cachePath()
    const { db } = openCacheDatabase(filePath)
    try {
      // 2 is INCREMENTAL. It can only be set on an empty database, which is why
      // `configure` runs before the first migration rather than after it.
      expect(db.pragma('auto_vacuum', { simple: true })).toBe(2)
    } finally {
      db.close()
    }
  })

  it('discards a cache written by a newer build instead of refusing to open', () => {
    // The library does the opposite, and deliberately: continuing against a
    // schema it does not understand would write rows the older build cannot
    // read. Nothing in the cache is worth that, so a downgrade costs a refetch.
    const filePath = cachePath()
    seed(filePath)
    const ahead = new Database(filePath)
    ahead.pragma('user_version = 99')
    ahead.close()

    const { db, migration, rebuilt, rebuiltBecause } = openCacheDatabase(filePath)
    try {
      expect(rebuilt).toBe(true)
      expect(rebuiltBecause).toMatch(/newer than this build/)
      expect(migration).toMatchObject({ from: 0, to: 1 })
      expect(entryCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('replaces a file that is not a database at all', () => {
    const filePath = cachePath()
    writeFileSync(filePath, 'this is not a SQLite file')

    const { db, rebuilt } = openCacheDatabase(filePath)
    try {
      expect(rebuilt).toBe(true)
      expect(entryCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('takes the write-ahead log with it, so nothing is replayed into the new file', () => {
    // An orphaned `-wal` is replayed into a freshly created database of the same
    // name, which would resurrect exactly what the delete was for.
    const filePath = cachePath()
    seed(filePath)
    writeFileSync(filePath, 'corrupt')
    writeFileSync(`${filePath}-wal`, 'stale log')

    const { db, rebuilt } = openCacheDatabase(filePath)
    try {
      expect(rebuilt).toBe(true)
      expect(entryCount(db)).toBe(0)
    } finally {
      db.close()
    }
    expect(existsSync(`${filePath}-wal`)).toBe(false)
  })
})

describe('openCacheService', () => {
  it('recreates a cache that was deleted while the app was closed', () => {
    // The acceptance criterion, literally: delete the file, start again, and the
    // only thing that is gone is the speed.
    const filePath = cachePath()
    const first = openCacheService(filePath, { log: () => {}, warn: () => {} })
    first.writeValue('wikipedia.extract', 'k', 'prose')
    first.close()

    rmSync(filePath)

    const second = openCacheService(filePath, { log: () => {}, warn: () => {} })
    try {
      expect(second.read('wikipedia.extract', 'k')).toBeNull()
      second.writeValue('wikipedia.extract', 'k', 'prose')
      expect(second.read('wikipedia.extract', 'k')).toEqual({ value: 'prose', fresh: true })
    } finally {
      second.close()
    }
  })

  it('degrades to a cache that remembers nothing when the path is unusable', () => {
    // A directory where the file should be: `openCacheDatabase` cannot rebuild
    // its way out of that, and the app still has to start.
    const dir = mkdtempSync(join(tmpdir(), 'oscine-cache-'))
    dirs.push(dir)
    const warn = vi.fn()

    const cache = openCacheService(dir, { log: () => {}, warn })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('continuing without it'))
    cache.writeValue('wikipedia.extract', 'k', 'prose')
    expect(cache.read('wikipedia.extract', 'k')).toBeNull()
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, negatives: 0 })
    cache.close()
  })
})
