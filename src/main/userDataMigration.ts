import { app } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * The one-time relocation of the userData directory across the Fermata → Oscine
 * rename.
 *
 * `app.getPath('userData')` is derived from the app name, and the rename changes
 * that name: the library SQLite database, the settings registry, the artwork
 * cache, the scrobble outbox and the sealed Last.fm credentials all live under
 * it. Without this, the first launch under the new name resolves an empty
 * directory and every existing install — dev machines included — boots with no
 * library and no sign-in. So the move happens once, at startup, before anything
 * opens the database.
 *
 * The directory is renamed, not copied: it is a same-filesystem move within the
 * userData parent, which is atomic and cannot half-populate the new location.
 */

/**
 * The pre-rename folder name for each post-rename one.
 *
 * Electron names the directory after the app name, which is the lowercase
 * package `name` (`oscine`) in a dev run and the `productName` (`Oscine`) in a
 * packaged build. Each maps to the Fermata folder that carried the same casing,
 * so keying off the current folder name — rather than guessing from the
 * platform — resolves dev and packaged correctly on both Windows and Linux at
 * once. A name that is not one of ours yields no plan, so this is inert for any
 * build whose identity is neither Fermata nor Oscine.
 */
const LEGACY_FOLDER_FOR: Readonly<Record<string, string>> = {
  oscine: 'fermata',
  Oscine: 'Fermata'
}

export interface UserDataMigration {
  readonly from: string
  readonly to: string
}

/** The single filesystem question this needs, injected so a test never touches a disk. */
export interface UserDataMigrationProbe {
  exists(path: string): boolean
}

/**
 * What to move, or `null` when there is nothing to do.
 *
 * `null` for every case that is not "the old directory is there and the new one
 * is not": an unknown identity, a fresh install with no old directory, and —
 * the important one — a new directory that already exists. A populated new
 * directory means the app has already run under the new name, and moving the
 * old one over it would bury the current library under a stale copy. The
 * caller having already migrated once is exactly the state this must refuse to
 * touch, which is what makes running it on every launch safe.
 */
export function planUserDataMigration(
  currentUserData: string,
  probe: UserDataMigrationProbe
): UserDataMigration | null {
  const currentName = basename(currentUserData)
  const legacyName = LEGACY_FOLDER_FOR[currentName]
  if (legacyName === undefined) return null

  const to = currentUserData
  // Swap the final segment in place rather than rejoining with `path.join`, whose
  // separator is the *host* platform's: reconstructing a Linux userData path on a
  // Windows runner would splice in a backslash and never match the real directory.
  // Slicing off the basename keeps whatever separator the input already used.
  const from = currentUserData.slice(0, currentUserData.length - currentName.length) + legacyName
  if (from === to) return null
  if (!probe.exists(from)) return null
  if (probe.exists(to)) return null
  return { from, to }
}

/**
 * Performs the relocation if one is due, and reports what it did.
 *
 * Returns the move that happened, or `null` when none was. **Must be called
 * synchronously before `app.whenReady()`**, not from inside it: Electron creates
 * the userData directory as it becomes ready, and `planUserDataMigration`
 * refuses once the destination exists, so a call made after ready always finds
 * the new directory already there and no-ops — stranding the old library under
 * the pre-rename name. A `null` return is the ordinary case on every launch
 * after the first under the new name.
 */
export function migrateUserDataDirectory(): UserDataMigration | null {
  const plan = planUserDataMigration(app.getPath('userData'), { exists: existsSync })
  if (plan === null) return null
  renameSync(plan.from, plan.to)
  return plan
}
