/**
 * D14's external-metadata cache: a second SQLite database beside the library,
 * carrying per-entity TTLs, negative entries and a size cap, and deletable
 * without loss.
 *
 * The separation from `library.db` is not tidiness. It is what makes every other
 * property in this directory available: a separate file can be deleted by an
 * operator who wants their machine to forget, rebuilt by the app when a
 * downgrade leaves a schema it does not understand, excluded from a backup by
 * name, and — the property the acceptance names — absent at startup without
 * anything going wrong. None of those can be said about a table.
 *
 * Nothing here crosses IPC. The renderer never sees a cache entry, only the
 * lookup result W7-9 will build on top of it, so the types stay in `src/main`
 * rather than in `src/shared`.
 */

export { openCacheDatabase, type OpenCacheDatabaseResult } from './open'
export {
  createCacheService,
  createNullCacheService,
  openCacheService,
  type CachedEntry,
  type CacheService,
  type CacheServiceOptions,
  type OpenCacheServiceOptions
} from './service'
export { createCacheStore, type CacheStats, type CacheStore, type StoredRow } from './store'
export {
  CACHE_ENTITIES,
  CACHE_ROW_OVERHEAD_BYTES,
  DEFAULT_CACHE_EVICT_TO_FRACTION,
  DEFAULT_CACHE_MAX_BYTES,
  DEFAULT_CACHE_MAX_ENTRY_BYTES,
  DEFAULT_CACHE_POLICY,
  DEFAULT_CACHE_TTLS,
  type CacheEntity,
  type CachePolicy,
  type EntityTtl
} from './policy'
export { CACHE_MIGRATIONS } from './migrations'
