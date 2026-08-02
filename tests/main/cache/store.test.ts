import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../../../src/main/db/migrate'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { createCacheStore } from '../../../src/main/cache/store'
import { DEFAULT_CACHE_POLICY, type CachePolicy } from '../../../src/main/cache/policy'

const open: Database.Database[] = []

function cacheDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db, CACHE_MIGRATIONS)
  open.push(db)
  return db
}

/** Overhead of 10 keeps the arithmetic in these tests readable. */
function policy(overrides: Partial<CachePolicy> = {}): CachePolicy {
  return { ...DEFAULT_CACHE_POLICY, rowOverheadBytes: 10, ...overrides }
}

/** `n` bytes of payload, so a test can say how big an entry is. */
function payload(bytes: number): string {
  return 'x'.repeat(bytes)
}

afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

describe('cache store', () => {
  it('round-trips an entry and reports a miss for an unknown key', () => {
    const store = createCacheStore(cacheDb(), policy())

    store.write('musicbrainz.artist', 'mbid', '{"name":"a"}', 2000, 1000)

    expect(store.read('musicbrainz.artist', 'mbid', 1000)).toMatchObject({
      payload: '{"name":"a"}',
      storedAt: 1000,
      expiresAt: 2000
    })
    expect(store.read('musicbrainz.artist', 'other', 1000)).toBeNull()
  })

  it('keeps entities in separate namespaces under the same key', () => {
    const store = createCacheStore(cacheDb(), policy())

    store.write('musicbrainz.artist', 'nirvana', 'mb', 2000, 1000)
    store.write('wikipedia.extract', 'nirvana', 'wp', 2000, 1000)

    expect(store.read('musicbrainz.artist', 'nirvana', 1000)?.payload).toBe('mb')
    expect(store.read('wikipedia.extract', 'nirvana', 1000)?.payload).toBe('wp')
  })

  it('stores a negative entry as a null payload, distinct from a JSON null', () => {
    const store = createCacheStore(cacheDb(), policy())

    store.write('musicbrainz.artist-search', 'nobody', null, 2000, 1000)
    store.write('musicbrainz.artist-search', 'somebody', 'null', 2000, 1000)

    expect(store.read('musicbrainz.artist-search', 'nobody', 1000)?.payload).toBeNull()
    expect(store.read('musicbrainz.artist-search', 'somebody', 1000)?.payload).toBe('null')
    expect(store.stats()).toMatchObject({ entries: 2, negatives: 1 })
  })

  it('replaces an entry in place rather than accumulating rows', () => {
    const store = createCacheStore(cacheDb(), policy())

    store.write('wikipedia.extract', 'k', payload(100), 2000, 1000)
    store.write('wikipedia.extract', 'k', payload(20), 5000, 3000)

    expect(store.stats()).toMatchObject({ entries: 1, bytes: 30 })
    expect(store.read('wikipedia.extract', 'k', 3000)).toMatchObject({
      storedAt: 3000,
      expiresAt: 5000
    })
  })

  it('does not renew recency when an entry is refreshed', () => {
    // The point of `used_at` being its own column: a refetch is not a use, so a
    // document nobody has looked at in a month stays first in line for eviction
    // even if its TTL happened to lapse and it was refreshed.
    const store = createCacheStore(cacheDb(), policy())

    store.write('wikipedia.extract', 'k', 'a', 2000, 1000)
    store.write('wikipedia.extract', 'k', 'b', 9000, 8000)

    expect(store.read('wikipedia.extract', 'k', 8000)?.usedAt).toBe(1000)
  })

  it('advances recency on a read, but not more often than the granularity', () => {
    const store = createCacheStore(cacheDb(), policy())
    store.write('wikipedia.extract', 'k', 'a', 10_000_000, 0)

    expect(store.read('wikipedia.extract', 'k', 30_000)?.usedAt).toBe(0)
    expect(store.read('wikipedia.extract', 'k', 90_000)?.usedAt).toBe(0)
    // The read above crossed the minute and wrote; this one observes it.
    expect(store.read('wikipedia.extract', 'k', 100_000)?.usedAt).toBe(90_000)
  })

  it('refuses an entry larger than the per-entry ceiling, and keeps the rest', () => {
    const store = createCacheStore(cacheDb(), policy({ maxEntryBytes: 100 }))

    expect(store.write('wikipedia.extract', 'small', payload(50), 2000, 1000)).toBe(true)
    expect(store.write('wikipedia.extract', 'huge', payload(500), 2000, 1000)).toBe(false)

    expect(store.read('wikipedia.extract', 'huge', 1000)).toBeNull()
    expect(store.stats()).toMatchObject({ entries: 1 })
  })

  describe('eviction', () => {
    it('drops expired entries before touching live ones', () => {
      const store = createCacheStore(cacheDb(), policy({ maxBytes: 100, evictToBytes: 90 }))

      // Two expired, one live, all the same size and all read equally recently.
      store.write('wikipedia.extract', 'expired-a', payload(30), 2000, 1000)
      store.write('wikipedia.extract', 'expired-b', payload(30), 2000, 1000)
      store.write('wikipedia.extract', 'live', payload(30), 900_000, 1000)

      // 4 × 40 = 160 bytes, over the cap of 100.
      store.write('wikipedia.extract', 'new', payload(30), 900_000, 500_000)

      expect(store.read('wikipedia.extract', 'expired-a', 500_000)).toBeNull()
      expect(store.read('wikipedia.extract', 'expired-b', 500_000)).toBeNull()
      expect(store.read('wikipedia.extract', 'live', 500_000)).not.toBeNull()
      expect(store.read('wikipedia.extract', 'new', 500_000)).not.toBeNull()
    })

    it('evicts least-recently-used once the expired entries are gone', () => {
      const store = createCacheStore(cacheDb(), policy({ maxBytes: 100, evictToBytes: 80 }))

      // Nothing expires; the only way back under the cap is by recency.
      store.write('wikipedia.extract', 'oldest', payload(30), 900_000, 1000)
      store.write('wikipedia.extract', 'middle', payload(30), 900_000, 2000)
      store.write('wikipedia.extract', 'newest', payload(30), 900_000, 3000)
      store.write('wikipedia.extract', 'fourth', payload(30), 900_000, 4000)

      // 160 bytes down to 80 has to free 80, which is two 40-byte rows.
      expect(store.read('wikipedia.extract', 'oldest', 4000)).toBeNull()
      expect(store.read('wikipedia.extract', 'middle', 4000)).toBeNull()
      expect(store.read('wikipedia.extract', 'newest', 4000)).not.toBeNull()
      expect(store.read('wikipedia.extract', 'fourth', 4000)).not.toBeNull()
    })

    it('spares an old entry that was read recently', () => {
      // LRU rather than FIFO, and the difference is the entry the operator keeps
      // going back to.
      const store = createCacheStore(cacheDb(), policy({ maxBytes: 140, evictToBytes: 100 }))

      store.write('wikipedia.extract', 'old-but-loved', payload(30), 900_000, 0)
      store.write('wikipedia.extract', 'b', payload(30), 900_000, 100_000)
      store.write('wikipedia.extract', 'c', payload(30), 900_000, 200_000)

      store.read('wikipedia.extract', 'old-but-loved', 300_000)

      // 4 × 40 = 160 over a cap of 140, freeing down to 100: two rows go, and
      // they are the two nobody has looked at since they were written.
      store.write('wikipedia.extract', 'd', payload(30), 900_000, 400_000)

      expect(store.read('wikipedia.extract', 'old-but-loved', 400_000)).not.toBeNull()
      expect(store.read('wikipedia.extract', 'b', 400_000)).toBeNull()
      expect(store.read('wikipedia.extract', 'c', 400_000)).toBeNull()
    })

    it('leaves the cache under its cap and above the low-water mark', () => {
      const store = createCacheStore(cacheDb(), policy({ maxBytes: 1000, evictToBytes: 900 }))

      for (let i = 0; i < 200; i++) {
        store.write('wikipedia.extract', `k${i}`, payload(90), 900_000, 1000 + i * 1000)
      }

      const { bytes } = store.stats()
      expect(bytes).toBeLessThanOrEqual(1000)
      expect(bytes).toBeGreaterThan(800)
    })

    it('does not evict on every write once the cache is full', () => {
      // The low-water mark's whole purpose. Trimming to exactly the cap would
      // make the next write over it again, so a full cache would pay for an LRU
      // sort per lookup forever.
      const store = createCacheStore(cacheDb(), policy({ maxBytes: 1000, evictToBytes: 900 }))

      // Rows of exactly 10 bytes, so 100 of them fill the cap and the 101st
      // trips an eviction down to 90.
      for (let i = 0; i <= 100; i++) {
        store.write('wikipedia.extract', `k${i}`, '', 900_000, 1000 + i * 1000)
      }
      expect(store.stats()).toMatchObject({ entries: 90, bytes: 900 })

      for (let i = 0; i < 5; i++) {
        store.write('wikipedia.extract', `later${i}`, '', 900_000, 200_000 + i * 1000)
      }

      // Five writes, five rows, no eviction in between. Trimming to the cap
      // instead of to the mark would have evicted on every one of them.
      expect(store.stats()).toMatchObject({ entries: 95, bytes: 950 })
    })

    it('charges negative entries against the cap so they cannot accumulate freely', () => {
      const store = createCacheStore(cacheDb(), policy({ maxBytes: 100, evictToBytes: 80 }))

      for (let i = 0; i < 50; i++) {
        store.write('musicbrainz.artist-search', `nobody-${i}`, null, 900_000, 1000 + i * 1000)
      }

      // 10 bytes of overhead each, capped at 100.
      expect(store.stats().entries).toBeLessThanOrEqual(10)
      expect(store.stats().bytes).toBeLessThanOrEqual(100)
    })
  })

  it('clears everything', () => {
    const store = createCacheStore(cacheDb(), policy())
    store.write('wikipedia.extract', 'a', 'x', 2000, 1000)
    store.write('musicbrainz.artist', 'b', null, 2000, 1000)

    store.clear()

    expect(store.stats()).toEqual({ entries: 0, bytes: 0, negatives: 0 })
    expect(store.read('wikipedia.extract', 'a', 1000)).toBeNull()
  })
})
