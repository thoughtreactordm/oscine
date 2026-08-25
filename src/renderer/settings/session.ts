import { RESTORE_SESSION_KEY, settingDefault, type TabSession } from '@shared/settings'
import type { SettingsReader } from './reader'

/**
 * Whether the tabs that were open last time come back.
 *
 * A gate on the *read* and on nothing else, which is the whole of it and is what
 * keeps this from being the parallel session mechanism it would be tempting to
 * build. The strip goes on recording what is open through the same watcher it
 * always used, so a launch with the gate shut opens empty and then records
 * "empty" — and turning the setting back on restores what was genuinely open
 * when Oscine last closed, which after such a run may be nothing.
 *
 * That is the honest behaviour rather than a shortcoming: the alternative,
 * suppressing the write too, would restore a session from before the setting was
 * ever turned off — days of tabs the operator has not seen since. What the
 * setting turns off is reopening, not recording.
 *
 * One function rather than an `if` in each of the two stores, so the two strips
 * cannot come to disagree about what "open on nothing" means: each key's own
 * default is what is handed back, and Podcasts' default falls to Discover where
 * Curate's falls to an empty strip.
 *
 * `SettingsReader` rather than the view store's concrete type because the gate
 * and the sessions are both view-scoped and the unified store satisfies it too;
 * the reason they are view-scoped is in the descriptor's own comment, and it is
 * that this is read while a store is being constructed, before the durable half
 * has necessarily hydrated.
 */
export function restoredTabSession(settings: SettingsReader, key: string): TabSession {
  if (!settings.get<boolean>(RESTORE_SESSION_KEY)) return settingDefault<TabSession>(key)
  return settings.get<TabSession>(key)
}
