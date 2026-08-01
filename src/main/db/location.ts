import { app } from 'electron'
import { join } from 'node:path'

export const DATABASE_FILENAME = 'library.db'
export const ARTWORK_CACHE_DIRECTORY = 'artwork-cache-v1'
export const PODCASTS_DIRECTORY = 'podcasts'

/**
 * Where the library lives on this machine.
 *
 * `userData` is per-user and survives upgrades, and D11 makes the database
 * strictly machine-local — so this path is never shared, synced or exported.
 * Moving libraries between machines goes through the export bundle instead.
 *
 * Isolated in its own module because it is the one part of `db/` that needs
 * Electron; everything else stays runnable under plain Node for tests.
 */
export function libraryDatabasePath(): string {
  return join(app.getPath('userData'), DATABASE_FILENAME)
}

/** Derived, disposable display thumbnails; never exposed as a renderer path. */
export function artworkCachePath(): string {
  return join(app.getPath('userData'), ARTWORK_CACHE_DIRECTORY)
}

/**
 * Downloaded episode files. Machine-local, not a library root — podcasts stay
 * out of Artist/Album/Song facets on purpose.
 */
export function podcastsDirectoryPath(): string {
  return join(app.getPath('userData'), PODCASTS_DIRECTORY)
}
