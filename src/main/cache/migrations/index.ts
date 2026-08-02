import type { Migration } from '../../db/migrate'
import { cacheEntries } from './001-cache-entries'

/**
 * The cache's own migration registry, numbered from 1 and independent of the
 * library's.
 *
 * Two registries, one `migrate`. The card asks for the cache to have its own
 * migration runner, and the part of "runner" that has to be its own is the
 * *registry and its version counter* — a schema step here must not consume a
 * version number over there, and `user_version` lives in each file's header, so
 * the two counters are already separate by construction. The algorithm that
 * walks a registry is not the part worth duplicating; `db/migrate.ts` is already
 * parameterised by the list.
 *
 * What differs is the recovery policy, and that lives in `../open.ts`: a library
 * newer than this build refuses to open, and a cache newer than this build is
 * deleted. The same function, given a different answer to "what does losing this
 * cost".
 */
export const CACHE_MIGRATIONS: readonly Migration[] = [cacheEntries]
