/**
 * The cache as its callers see it: TTLs, negative entries, and one function that
 * puts a fetch behind both.
 *
 * W7-7 left a note saying this layer sits *between* the client and its callers
 * rather than inside it, and `through` is the whole reason. The client knows how
 * to make one request correctly; it has no business knowing that a 404 for an
 * artist name is worth remembering for a week. Putting that here means W7-9's
 * four endpoints inherit the rule instead of restating it four times, and the
 * fifth endpoint somebody adds in a year inherits it too.
 *
 * ## The rules `through` encodes
 *
 * **A fresh entry answers without asking.** Including when consent is off. D14's
 * rule is that nothing is *fetched* without the operator agreeing, and reading a
 * row we already have opens no socket and sends nothing — so the deck stays
 * populated when lookups are switched off, and `clear()` is the control for an
 * operator who wants the data gone rather than merely frozen. This is also the
 * literal acceptance criterion: a warm artist renders with the network
 * unplugged.
 *
 * **Only `not-found` is cached negatively.** This is the narrow rule and it is
 * narrow on purpose. `not-found` means the service answered and had nothing,
 * which is a fact about the world and stays true for a while. `offline`,
 * `timeout`, `unavailable` and `rate-limited` mean we failed to ask — caching
 * those would turn a flaky minute into a week of pretending an artist does not
 * exist. `rejected` and `malformed` are bugs in our own request or parser, and
 * persisting them across restarts is how a bug becomes unreproducible.
 *
 * **A stale entry beats a failure.** When the TTL has passed and the refetch
 * cannot be made, the choice is between last month's biography and a blank pane,
 * and last month's biography is what was on screen yesterday. Negative entries
 * are excluded from this: reporting "the service has nothing for this artist"
 * when the truth is "we could not reach the service" is a lie the operator would
 * act on, by going and correcting a tag that was never wrong.
 */

import { netFailed, netOk, type NetFailureKind, type NetResult } from '@shared/net'
import type Database from 'better-sqlite3'
import { openCacheDatabase } from './open'
import { DEFAULT_CACHE_POLICY, type CacheEntity, type CachePolicy } from './policy'
import { createCacheStore, type CacheStats, type CacheStore } from './store'

/**
 * What the cache holds for a key.
 *
 * A miss is `null`. A negative entry is a present record with a `null` value —
 * the distinction the whole card turns on, and one an optional-value-only API
 * cannot express.
 */
export interface CachedEntry<T> {
  /** `null` when the service answered and had nothing. */
  readonly value: T | null
  /** False once the TTL has passed. Still returned; see stale-if-error. */
  readonly fresh: boolean
}

/**
 * The failures a stale positive entry is allowed to stand in for.
 *
 * Everything here means "we could not get an answer". `declined` is included
 * because with lookups switched off there will never be a fresher one, so the
 * alternative to stale is permanently nothing. `cancelled` is not: the operator
 * closed the deck, and there is nobody left to render to. `rejected` and
 * `malformed` are not: they are ours to fix, and papering over them with a month
 * old document is how they go unnoticed.
 */
const STALE_ANSWERS_FOR: readonly NetFailureKind[] = [
  'declined',
  'offline',
  'timeout',
  'rate-limited',
  'unavailable'
]

/** Phrased exactly as the client phrases it, so a cached 404 is indistinguishable. */
const NOT_FOUND = {
  kind: 'not-found',
  message: 'The service has nothing for this.'
} as const

export interface CacheService {
  /** The entry for a key, fresh or stale, or `null` if there is none. */
  read<T>(entity: CacheEntity, key: string): CachedEntry<T> | null
  /**
   * Every value held under an entity, fresh or stale, negatives excluded.
   *
   * Not a general query facility — there is exactly one caller and one reason
   * for it. W7-13 stores an artist photograph in the artwork cache and its
   * reference here, so the thing that prunes that directory has to be able to
   * ask this database which files are still spoken for. Damaged rows are
   * skipped rather than thrown over, for `read`'s reason.
   */
  values<T>(entity: CacheEntity): T[]
  /** Stores an answer under the entity's positive TTL. */
  writeValue<T>(entity: CacheEntity, key: string, value: T): void
  /** Records that the service had nothing, under the entity's negative TTL. */
  writeNegative(entity: CacheEntity, key: string): void
  /**
   * Answers from the cache when it can, and fills it from `fetch` when it
   * cannot. The one function callers should be reaching for.
   */
  through<T>(
    entity: CacheEntity,
    key: string,
    fetch: () => Promise<NetResult<T>>
  ): Promise<NetResult<T>>
  /** Forgets everything. The operator-facing "and delete what you learned". */
  clear(): void
  stats(): CacheStats
  close(): void
}

export interface CacheServiceOptions {
  db: Database.Database
  policy?: CachePolicy
  /** Injected so TTL and eviction tests do not wait a fortnight. */
  now?: () => number
}

export function createCacheService({
  db,
  policy = DEFAULT_CACHE_POLICY,
  now = Date.now
}: CacheServiceOptions): CacheService {
  const store: CacheStore = createCacheStore(db, policy)

  function write(entity: CacheEntity, key: string, payload: string | null, ttlMs: number): void {
    const at = now()
    store.write(entity, key, payload, at + ttlMs, at)
  }

  const service: CacheService = {
    read<T>(entity: CacheEntity, key: string): CachedEntry<T> | null {
      const at = now()
      const row = store.read(entity, key, at)
      if (!row) return null

      const fresh = row.expiresAt > at
      if (row.payload === null) return { value: null, fresh }

      try {
        return { value: JSON.parse(row.payload) as T, fresh }
      } catch {
        // Only reachable if the file was edited or damaged in a way that still
        // opened. Reading it as a miss refetches; reading it as an error would
        // make a damaged cache an unusable app.
        return null
      }
    },

    values<T>(entity: CacheEntity): T[] {
      const out: T[] = []
      for (const payload of store.listPayloads(entity)) {
        try {
          out.push(JSON.parse(payload) as T)
        } catch {
          // Unreadable row. Skipping it means prune treats whatever it
          // referenced as unreferenced, which deletes a file that will be
          // regenerated on the next lookup — the disposable outcome.
        }
      }
      return out
    },

    writeValue<T>(entity: CacheEntity, key: string, value: T): void {
      write(entity, key, JSON.stringify(value), policy.ttls[entity].freshMs)
    },

    writeNegative(entity: CacheEntity, key: string): void {
      write(entity, key, null, policy.ttls[entity].negativeMs)
    },

    async through<T>(
      entity: CacheEntity,
      key: string,
      fetch: () => Promise<NetResult<T>>
    ): Promise<NetResult<T>> {
      const entry = service.read<T>(entity, key)
      if (entry?.fresh) {
        return entry.value === null ? netFailed(NOT_FOUND) : netOk(entry.value)
      }

      const result = await fetch()

      if (result.ok) {
        service.writeValue(entity, key, result.value)
        return result
      }

      if (result.failure.kind === 'not-found') {
        service.writeNegative(entity, key)
        return result
      }

      if (entry && entry.value !== null && STALE_ANSWERS_FOR.includes(result.failure.kind)) {
        return netOk(entry.value)
      }

      return result
    },

    clear(): void {
      store.clear()
    },

    stats(): CacheStats {
      return store.stats()
    },

    close(): void {
      db.close()
    }
  }

  return service
}

/**
 * A cache that remembers nothing, for when there is no usable one.
 *
 * Every method is the honest no-op: reads miss, writes vanish, and `through`
 * fetches. That the application is *fully correct* against this — slower, more
 * requests, nothing else — is what "deleting `cache.db` loses nothing but speed"
 * means when stated as code rather than as prose. It is also what lets
 * `openCacheService` refuse to fail: a machine whose data directory is read-only
 * gets a Oscine that works.
 */
export function createNullCacheService(): CacheService {
  return {
    read: () => null,
    values: () => [],
    writeValue: () => {},
    writeNegative: () => {},
    through: (_entity, _key, fetch) => fetch(),
    clear: () => {},
    stats: () => ({ entries: 0, bytes: 0, negatives: 0 }),
    close: () => {}
  }
}

export interface OpenCacheServiceOptions extends Omit<CacheServiceOptions, 'db'> {
  /** Where the log line goes. Defaults to the console. */
  log?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * Opens `cache.db` and wraps it in a service, degrading to the null cache rather
 * than throwing.
 *
 * `openCacheDatabase` already rebuilds a file it cannot read, so reaching the
 * catch here means the *directory* is the problem — read-only, full, gone. That
 * is worth a warning and is not worth refusing to launch over, which is the
 * entire difference between this and `openDatabase`.
 */
export function openCacheService(
  filePath: string,
  { log = console.info, warn = console.warn, ...options }: OpenCacheServiceOptions = {}
): CacheService {
  try {
    const { db, migration, rebuilt, rebuiltBecause } = openCacheDatabase(filePath)
    // One line per outcome rather than a warning followed by a migration note.
    // The two would go to different streams, and stdout and stderr interleave by
    // whichever flushes first — a rebuild that reads as having happened *after*
    // the migration it caused is a log line that costs somebody an afternoon.
    if (rebuilt) {
      warn(`[cache] ${filePath} — discarded and rebuilt at v${migration.to}: ${rebuiltBecause}`)
    } else {
      log(
        migration.applied.length === 0
          ? `[cache] ${filePath} — schema v${migration.to}, up to date`
          : `[cache] ${filePath} — migrated v${migration.from} to v${migration.to}`
      )
    }
    return createCacheService({ db, ...options })
  } catch (error) {
    warn(
      `[cache] ${filePath} — unavailable, continuing without it: ` +
        (error instanceof Error ? error.message : String(error))
    )
    return createNullCacheService()
  }
}
