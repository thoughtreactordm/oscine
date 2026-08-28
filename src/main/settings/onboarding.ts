/**
 * D-ONB-7: decide whether this user-data directory has already been onboarded,
 * without ever dropping an existing install back into the wizard.
 *
 * The key itself defaults to `false`, which is the right answer for a genuinely
 * fresh directory and the wrong one for an upgrade. This runs once at startup,
 * while the key is still unset, and writes `true` when the profile is not
 * fresh. It does **not** look at whether the library is empty *now* — an
 * operator who removed every root stays onboarded because the key was already
 * written — and it does not overwrite a row the operator (or a previous run)
 * already stored.
 */

import type BetterSqlite3 from 'better-sqlite3'
import { ONBOARDING_COMPLETED_KEY } from '@shared/settings'
import type { SettingsService } from './service'

/**
 * If the done-key has no row yet, write `true` for a lived-in profile.
 *
 * A lived-in profile is one that already has a durable settings row, or a
 * library with roots or tracks. A truly fresh user-data directory has neither,
 * and is left at the default `false` so the renderer opens the wizard.
 */
export function backfillOnboardingCompleted(
  db: BetterSqlite3.Database,
  settings: SettingsService
): void {
  if (onboardingKeyIsStored(db)) return
  if (!profileLooksLivedIn(db)) return
  settings.set({ key: ONBOARDING_COMPLETED_KEY, value: true })
}

function onboardingKeyIsStored(db: BetterSqlite3.Database): boolean {
  return exists(db, 'SELECT 1 AS n FROM settings WHERE key = ? LIMIT 1', ONBOARDING_COMPLETED_KEY)
}

function profileLooksLivedIn(db: BetterSqlite3.Database): boolean {
  // Any settings row at all: when the onboarding key is unset, that row is some
  // other durable setting already written — including one this build has no
  // descriptor for, which `storedKeys` would otherwise drop.
  if (exists(db, 'SELECT 1 AS n FROM settings LIMIT 1')) return true
  if (exists(db, 'SELECT 1 AS n FROM roots LIMIT 1')) return true
  return exists(db, 'SELECT 1 AS n FROM tracks LIMIT 1')
}

function exists(db: BetterSqlite3.Database, sql: string, bind?: string): boolean {
  const row = bind === undefined ? db.prepare(sql).get() : db.prepare(sql).get(bind)
  return row != null
}
