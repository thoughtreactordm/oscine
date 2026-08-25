/**
 * The one-time userData relocation across the Fermata → Oscine rename.
 *
 * `app.getPath('userData')` is derived from the app name, so the rename moves
 * the directory the entire library lives under. The planner is the whole of the
 * decision — the runner only calls `renameSync` on what it returns — so every
 * case that must NOT move (already migrated, fresh install, still on the old
 * name) is a `null` here rather than a comment.
 */

import { describe, expect, it } from 'vitest'
import {
  planUserDataMigration,
  type UserDataMigrationProbe
} from '../../src/main/userDataMigration'

/** A fake filesystem: the set of directories that exist. */
function probeOf(...paths: string[]): UserDataMigrationProbe {
  const present = new Set(paths)
  return { exists: (path) => present.has(path) }
}

describe('planning the userData relocation', () => {
  it('moves the lowercase dev directory, which is named after the package', () => {
    expect(
      planUserDataMigration('/home/u/.config/oscine', probeOf('/home/u/.config/fermata'))
    ).toEqual({ from: '/home/u/.config/fermata', to: '/home/u/.config/oscine' })
  })

  it('moves the capitalised packaged directory, which is named after productName', () => {
    expect(planUserDataMigration('/data/Roaming/Oscine', probeOf('/data/Roaming/Fermata'))).toEqual(
      {
        from: '/data/Roaming/Fermata',
        to: '/data/Roaming/Oscine'
      }
    )
  })

  it('refuses to move onto a new directory that already exists', () => {
    // The app has run under the new name; the old directory is a stale copy to
    // leave alone, not one to bury the current library under.
    expect(planUserDataMigration('/c/oscine', probeOf('/c/fermata', '/c/oscine'))).toBeNull()
  })

  it('does nothing when there is no old directory to move', () => {
    expect(planUserDataMigration('/c/oscine', probeOf())).toBeNull()
  })

  it('does nothing while still running under the old name', () => {
    // Proves wiring the migration in before the package.json rename is a safe
    // no-op: nothing resolves to Oscine yet, so there is nothing to plan.
    expect(planUserDataMigration('/c/fermata', probeOf('/c/fermata'))).toBeNull()
  })

  it('ignores an identity that is neither Fermata nor Oscine', () => {
    expect(planUserDataMigration('/c/something', probeOf('/c/something'))).toBeNull()
  })
})
