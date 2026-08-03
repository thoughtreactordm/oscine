import { app } from 'electron'
import { join } from 'node:path'
import {
  ARTWORK_CACHE_ARTIFACT,
  CACHE_DATABASE_ARTIFACT,
  LIBRARY_DATABASE_ARTIFACT,
  PODCASTS_ARTIFACT,
  SCROBBLE_CREDENTIALS_ARTIFACT
} from './artifacts'

// Re-exported rather than written here: `artifacts.ts` is the one place a name
// under `userData` is decided, because it is also where that name's side of D11
// is decided, and two lists would eventually disagree about the second while
// agreeing about the first.
export const DATABASE_FILENAME = LIBRARY_DATABASE_ARTIFACT.name
export const CACHE_DATABASE_FILENAME = CACHE_DATABASE_ARTIFACT.name
export const ARTWORK_CACHE_DIRECTORY = ARTWORK_CACHE_ARTIFACT.name
export const PODCASTS_DIRECTORY = PODCASTS_ARTIFACT.name
export const SCROBBLE_CREDENTIALS_FILENAME = SCROBBLE_CREDENTIALS_ARTIFACT.name

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

/**
 * D14's external-metadata cache — beside the library, never inside it.
 *
 * A sibling file rather than more tables in `library.db`, and the separation is
 * the whole point: a second file can be deleted by the operator, rebuilt by the
 * app after a bad upgrade, and excluded from a backup by name. None of those are
 * available to a table.
 */
export function cacheDatabasePath(): string {
  return join(app.getPath('userData'), CACHE_DATABASE_FILENAME)
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

/**
 * D19's session keys, sealed by `safeStorage`.
 *
 * A file of its own rather than rows in `library.db`, and that is the decision
 * rather than an implementation detail: the settings table is exported, dumped
 * into bug reports and read by the operator, and a credential that lives there
 * is a credential one careless `SELECT *` away from a screenshot. A separate
 * file has a name that `EXPORT_EXCLUDED_ARTIFACTS` can refuse and that a human
 * can delete to sign out of everything at once.
 */
export function scrobbleCredentialsPath(): string {
  return join(app.getPath('userData'), SCROBBLE_CREDENTIALS_FILENAME)
}
