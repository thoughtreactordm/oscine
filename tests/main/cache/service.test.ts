import Database from 'better-sqlite3'
import { netFailed, netOk, type NetFailureKind, type NetResult } from '@shared/net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { DEFAULT_CACHE_POLICY, type CachePolicy } from '../../../src/main/cache/policy'
import {
  createCacheService,
  createNullCacheService,
  type CacheService
} from '../../../src/main/cache/service'
import { migrate } from '../../../src/main/db/migrate'

const DAY = 24 * 60 * 60 * 1000

const open: Database.Database[] = []

afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

interface Harness {
  cache: CacheService
  /** Moves the injected clock. Every TTL test is a call to this. */
  advance(ms: number): void
}

function harness(policy: CachePolicy = DEFAULT_CACHE_POLICY): Harness {
  const db = new Database(':memory:')
  migrate(db, CACHE_MIGRATIONS)
  open.push(db)

  let now = 1_700_000_000_000
  return {
    cache: createCacheService({ db, policy, now: () => now }),
    advance: (ms) => {
      now += ms
    }
  }
}

function failing<T>(kind: NetFailureKind): () => Promise<NetResult<T>> {
  return () => Promise.resolve(netFailed<T>({ kind, message: `${kind} happened` }))
}

describe('cache service', () => {
  describe('reading and writing', () => {
    it('round-trips a value and reports it fresh', () => {
      const { cache } = harness()
      cache.writeValue('musicbrainz.artist', 'mbid', { name: 'Boards of Canada' })

      expect(cache.read('musicbrainz.artist', 'mbid')).toEqual({
        value: { name: 'Boards of Canada' },
        fresh: true
      })
    })

    it('distinguishes a miss from a negative entry from a null document', () => {
      const { cache } = harness()
      cache.writeNegative('musicbrainz.artist-search', 'unmatchable')
      cache.writeValue('musicbrainz.artist-search', 'nulldoc', null)

      expect(cache.read('musicbrainz.artist-search', 'never-asked')).toBeNull()
      expect(cache.read('musicbrainz.artist-search', 'unmatchable')).toEqual({
        value: null,
        fresh: true
      })
      // A document that *is* null is a positive entry, and must not read as the
      // service having nothing.
      expect(cache.read<null>('musicbrainz.artist-search', 'nulldoc')).toEqual({
        value: null,
        fresh: true
      })
      expect(cache.stats()).toMatchObject({ entries: 2, negatives: 1 })
    })

    it('goes stale at the entity TTL and stays readable', () => {
      const { cache, advance } = harness()
      cache.writeValue('wikipedia.extract', 'k', 'prose')

      advance(14 * DAY - 1)
      expect(cache.read('wikipedia.extract', 'k')).toMatchObject({ fresh: true })

      advance(2)
      expect(cache.read('wikipedia.extract', 'k')).toEqual({ value: 'prose', fresh: false })
    })

    it('expires a negative entry on the shorter negative TTL', () => {
      const { cache, advance } = harness()
      cache.writeNegative('musicbrainz.artist-search', 'unmatchable')

      advance(7 * DAY - 1)
      expect(cache.read('musicbrainz.artist-search', 'unmatchable')).toMatchObject({ fresh: true })

      advance(2)
      expect(cache.read('musicbrainz.artist-search', 'unmatchable')).toMatchObject({ fresh: false })
    })

    it('reads a damaged payload as a miss rather than throwing', () => {
      const { cache } = harness()
      cache.writeValue('wikipedia.extract', 'k', 'fine')
      // Reaching past the service to damage the row the way a bad disk would.
      open[open.length - 1].prepare("UPDATE cache_entries SET payload = '{not json'").run()

      expect(cache.read('wikipedia.extract', 'k')).toBeNull()
    })

    it('forgets everything on clear', () => {
      const { cache } = harness()
      cache.writeValue('musicbrainz.artist', 'a', { x: 1 })
      cache.writeNegative('musicbrainz.artist-search', 'b')

      cache.clear()

      expect(cache.stats()).toEqual({ entries: 0, bytes: 0, negatives: 0 })
    })
  })

  describe('through', () => {
    it('fetches on a miss and stores the answer', async () => {
      const { cache } = harness()
      const fetch = vi.fn(() => Promise.resolve(netOk({ name: 'Autechre' })))

      await expect(cache.through('musicbrainz.artist', 'ae', fetch)).resolves.toEqual(
        netOk({ name: 'Autechre' })
      )
      expect(cache.read('musicbrainz.artist', 'ae')).toMatchObject({ fresh: true })
    })

    it('answers a warm key without fetching at all', async () => {
      // The acceptance criterion, in the only form a unit test can state it: the
      // network is not merely unused, it is not reached for.
      const { cache } = harness()
      cache.writeValue('musicbrainz.artist', 'ae', { name: 'Autechre' })
      const fetch = vi.fn(() => Promise.resolve(netOk({ name: 'nope' })))

      await expect(cache.through('musicbrainz.artist', 'ae', fetch)).resolves.toEqual(
        netOk({ name: 'Autechre' })
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('queries an unmatchable artist once and not again until the negative TTL lapses', async () => {
      // R5's named failure: without this, every play of a track whose artist tag
      // matches nothing burns a rate-limit slot, and a shuffle session burns one
      // a second for as long as it runs.
      const { cache, advance } = harness()
      const fetch = vi.fn(failing<unknown>('not-found'))

      const first = await cache.through('musicbrainz.artist-search', 'Various Artists', fetch)
      expect(first).toMatchObject({ ok: false, failure: { kind: 'not-found' } })
      expect(fetch).toHaveBeenCalledTimes(1)

      // A hundred more plays over the following week.
      for (let i = 0; i < 100; i++) {
        advance(DAY / 20)
        const again = await cache.through('musicbrainz.artist-search', 'Various Artists', fetch)
        expect(again).toMatchObject({ ok: false, failure: { kind: 'not-found' } })
      }
      expect(fetch).toHaveBeenCalledTimes(1)

      // And then it is worth asking again, because MusicBrainz gains artists.
      advance(3 * DAY)
      await cache.through('musicbrainz.artist-search', 'Various Artists', fetch)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it.each<NetFailureKind>(['offline', 'timeout', 'unavailable', 'rate-limited', 'rejected'])(
      'does not cache a %s failure',
      async (kind) => {
        const { cache } = harness()
        const fetch = vi.fn(failing<unknown>(kind))

        await cache.through('musicbrainz.artist', 'k', fetch)
        await cache.through('musicbrainz.artist', 'k', fetch)

        expect(fetch).toHaveBeenCalledTimes(2)
        expect(cache.stats().entries).toBe(0)
      }
    )

    it('refetches once an entry has gone stale', async () => {
      const { cache, advance } = harness()
      cache.writeValue('wikipedia.extract', 'k', 'old')
      const fetch = vi.fn(() => Promise.resolve(netOk('new')))

      advance(15 * DAY)
      await expect(cache.through('wikipedia.extract', 'k', fetch)).resolves.toEqual(netOk('new'))
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(cache.read('wikipedia.extract', 'k')).toEqual({ value: 'new', fresh: true })
    })

    it.each<NetFailureKind>(['offline', 'timeout', 'unavailable', 'rate-limited', 'declined'])(
      'serves a stale entry rather than a %s failure',
      async (kind) => {
        const { cache, advance } = harness()
        cache.writeValue('wikipedia.extract', 'k', 'last month')

        advance(20 * DAY)
        await expect(
          cache.through('wikipedia.extract', 'k', failing<string>(kind))
        ).resolves.toEqual(netOk('last month'))
      }
    )

    it.each<NetFailureKind>(['cancelled', 'rejected', 'malformed'])(
      'reports a %s failure even when a stale entry exists',
      async (kind) => {
        const { cache, advance } = harness()
        cache.writeValue('wikipedia.extract', 'k', 'last month')

        advance(20 * DAY)
        await expect(
          cache.through('wikipedia.extract', 'k', failing<string>(kind))
        ).resolves.toMatchObject({ ok: false, failure: { kind } })
      }
    )

    it('never lets a stale negative stand in for an unreachable service', async () => {
      // "The service has nothing for this artist" and "we could not ask" are
      // different sentences, and only one of them sends the operator off to
      // correct a tag that was never wrong.
      const { cache, advance } = harness()
      cache.writeNegative('musicbrainz.artist-search', 'unmatchable')

      advance(8 * DAY)
      await expect(
        cache.through('musicbrainz.artist-search', 'unmatchable', failing<unknown>('offline'))
      ).resolves.toMatchObject({ ok: false, failure: { kind: 'offline' } })
    })

    it('refreshes a stale negative into a positive when the artist finally appears', async () => {
      const { cache, advance } = harness()
      cache.writeNegative('musicbrainz.artist-search', 'new band')

      advance(8 * DAY)
      const fetch = vi.fn(() => Promise.resolve(netOk({ mbid: 'abc' })))
      await expect(cache.through('musicbrainz.artist-search', 'new band', fetch)).resolves.toEqual(
        netOk({ mbid: 'abc' })
      )
      expect(cache.read('musicbrainz.artist-search', 'new band')).toEqual({
        value: { mbid: 'abc' },
        fresh: true
      })
      expect(cache.stats()).toMatchObject({ entries: 1, negatives: 0 })
    })
  })

  /**
   * The one query in this layer that is not keyed, and the one caller for it.
   *
   * W7-13 puts an artist photograph in the *artwork* cache and its hash in a row
   * here, so the thing that prunes that directory has to be able to ask this
   * database which files are still spoken for. The two properties that matter
   * are that it is scoped to an entity — a prune that saw MusicBrainz documents
   * as artwork references would keep every file forever — and that expiry does
   * not filter it, because an expired row is still a row and its file is still
   * the one the next refresh would reuse.
   */
  describe('listing what an entity holds', () => {
    it('returns one entity’s values and nobody else’s', () => {
      const { cache } = harness()
      cache.writeValue('commons.image', 'Q1', { hash: 'aaa' })
      cache.writeValue('commons.image', 'Q2', { hash: 'bbb' })
      cache.writeValue('musicbrainz.artist', 'mbid', { hash: 'not-artwork' })

      const hashes = cache.values<{ hash: string }>('commons.image').map((row) => row.hash)
      expect(hashes.sort()).toEqual(['aaa', 'bbb'])
    })

    it('excludes negative entries, which name no file', () => {
      const { cache } = harness()
      cache.writeValue('commons.image', 'Q1', { hash: 'aaa' })
      cache.writeNegative('commons.image', 'Q2')

      expect(cache.values('commons.image')).toEqual([{ hash: 'aaa' }])
    })

    it('still lists a value whose TTL has passed', () => {
      const { cache, advance } = harness()
      cache.writeValue('commons.image', 'Q1', { hash: 'aaa' })
      advance(90 * DAY)

      // Stale, and its thumbnails must not be deleted out from under a refresh
      // that is about to reuse them.
      expect(cache.read('commons.image', 'Q1')?.fresh).toBe(false)
      expect(cache.values('commons.image')).toEqual([{ hash: 'aaa' }])
    })

    it('is empty once the operator clears the cache', () => {
      const { cache } = harness()
      cache.writeValue('commons.image', 'Q1', { hash: 'aaa' })
      cache.clear()

      // Which is what makes "clear the cache" also give the disk back: the
      // artwork prune then sees no reference and removes the files.
      expect(cache.values('commons.image')).toEqual([])
    })
  })

  describe('the null cache', () => {
    it('misses everything, keeps nothing, and fetches every time', async () => {
      const cache = createNullCacheService()
      const fetch = vi.fn(() => Promise.resolve(netOk('value')))

      cache.writeValue('musicbrainz.artist', 'k', 'value')
      cache.writeNegative('musicbrainz.artist', 'n')

      expect(cache.read('musicbrainz.artist', 'k')).toBeNull()
      await expect(cache.through('musicbrainz.artist', 'k', fetch)).resolves.toEqual(netOk('value'))
      await expect(cache.through('musicbrainz.artist', 'k', fetch)).resolves.toEqual(netOk('value'))
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(cache.values('commons.image')).toEqual([])
      expect(cache.stats()).toEqual({ entries: 0, bytes: 0, negatives: 0 })
    })
  })
})
