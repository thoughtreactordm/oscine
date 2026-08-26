import {
  EMPTY_QUEUE_SESSION,
  QUEUE_SESSION_KEY,
  RESTORE_QUEUE_KEY,
  RESTORE_SESSION_KEY,
  settingDefault,
  type QueueSession,
  type TabSession
} from '@shared/settings'
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

/**
 * The last queue, or the empty session when the gate is shut.
 *
 * The gate here is `view.restoreQueue`, and it differs from the tab gate above
 * in one deliberate way: the queue snapshot's *write* is gated too, in
 * `usePlaybackStore`. Tabs record whatever is open regardless, because a tab is
 * cheap and always-recording is what lets the setting be turned back on and find
 * something there. A queue snapshot names the tracks the operator was playing,
 * and remembering that while they have asked not to is the wrong default — so a
 * shut gate here means both "do not reopen" and "do not record", and this read
 * returns the empty session either way.
 */
export function restoredQueueSession(settings: SettingsReader): QueueSession {
  if (!settings.get<boolean>(RESTORE_QUEUE_KEY)) return { ...EMPTY_QUEUE_SESSION }
  return settings.get<QueueSession>(QUEUE_SESSION_KEY)
}
