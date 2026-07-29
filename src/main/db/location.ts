import { app } from 'electron'
import { join } from 'node:path'

export const DATABASE_FILENAME = 'library.db'

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
