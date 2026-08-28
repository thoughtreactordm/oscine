import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import { backfillOnboardingCompleted, SqliteSettingsService } from '../../../src/main/settings'
import {
  DURATION_FORMAT_KEY,
  getSetting,
  ONBOARDING_COMPLETED_KEY,
  settingsInCategory
} from '../../../src/shared/settings'

/**
 * D-ONB-7's startup gate: a fresh user-data directory stays `false`, an existing
 * install is backfilled to `true`, and a value already on disk is never flipped.
 */

const openDatabases: Database.Database[] = []

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close()
})

function libraryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db, MIGRATIONS)
  openDatabases.push(db)
  return db
}

function settingsFor(db: Database.Database): SqliteSettingsService {
  return new SqliteSettingsService({ db })
}

function seedRoot(db: Database.Database): void {
  db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)').run('Music', '/music', 1)
}

function seedDurableSetting(db: Database.Database): void {
  db.prepare(
    'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1)'
  ).run(DURATION_FORMAT_KEY, 'global', null, '"hours"', 1)
}

describe('interface.onboardingCompleted', () => {
  it('is durable, internal, not portable, and defaults to false', () => {
    const descriptor = getSetting(ONBOARDING_COMPLETED_KEY)
    expect(descriptor).toMatchObject({
      key: ONBOARDING_COMPLETED_KEY,
      scope: 'durable',
      internal: true,
      portable: false,
      default: false
    })
    expect(descriptor?.control).toBeNull()
    expect(settingsInCategory('interface').map((entry) => entry.key)).not.toContain(
      ONBOARDING_COMPLETED_KEY
    )
  })
})

describe('backfillOnboardingCompleted', () => {
  it('leaves a fresh directory at false, with no row', () => {
    const db = libraryDb()
    const settings = settingsFor(db)

    backfillOnboardingCompleted(db, settings)

    expect(settings.get<boolean>(ONBOARDING_COMPLETED_KEY)).toBe(false)
    expect(settings.getAll().storedKeys).not.toContain(ONBOARDING_COMPLETED_KEY)
  })

  it('writes true when a root already exists', () => {
    const db = libraryDb()
    seedRoot(db)
    const settings = settingsFor(db)

    backfillOnboardingCompleted(db, settings)

    expect(settings.get<boolean>(ONBOARDING_COMPLETED_KEY)).toBe(true)
    expect(settings.getAll().storedKeys).toContain(ONBOARDING_COMPLETED_KEY)
  })

  it('writes true when a durable setting is already stored, with no library', () => {
    const db = libraryDb()
    seedDurableSetting(db)
    const settings = settingsFor(db)

    backfillOnboardingCompleted(db, settings)

    expect(settings.get<boolean>(ONBOARDING_COMPLETED_KEY)).toBe(true)
    expect(settings.get<string>(DURATION_FORMAT_KEY)).toBe('hours')
  })

  it('treats an unknown settings row as lived-in, not as a fresh directory', () => {
    const db = libraryDb()
    db.prepare(
      'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
        "VALUES ('branch.unknownKey', 'global', NULL, 'true', 1, 1)"
    ).run()
    const settings = settingsFor(db)

    backfillOnboardingCompleted(db, settings)

    expect(settings.get<boolean>(ONBOARDING_COMPLETED_KEY)).toBe(true)
  })

  it('does not flip an operator-set false, even with a library', () => {
    const db = libraryDb()
    const settings = settingsFor(db)
    settings.set({ key: ONBOARDING_COMPLETED_KEY, value: false })
    seedRoot(db)

    backfillOnboardingCompleted(db, settings)
    backfillOnboardingCompleted(db, settings)

    expect(settings.get<boolean>(ONBOARDING_COMPLETED_KEY)).toBe(false)
  })

  it('does not flip an operator-set true after the library is emptied', () => {
    const db = libraryDb()
    seedRoot(db)
    const settings = settingsFor(db)
    settings.set({ key: ONBOARDING_COMPLETED_KEY, value: true })
    db.prepare('DELETE FROM roots').run()

    backfillOnboardingCompleted(db, settings)
    backfillOnboardingCompleted(db, settings)

    expect(settings.get<boolean>(ONBOARDING_COMPLETED_KEY)).toBe(true)
  })

  it('is a no-op the second time on a fresh directory', () => {
    const db = libraryDb()
    const settings = settingsFor(db)

    backfillOnboardingCompleted(db, settings)
    backfillOnboardingCompleted(db, settings)

    expect(settings.get<boolean>(ONBOARDING_COMPLETED_KEY)).toBe(false)
    expect(settings.getAll().storedKeys).not.toContain(ONBOARDING_COMPLETED_KEY)
  })
})
