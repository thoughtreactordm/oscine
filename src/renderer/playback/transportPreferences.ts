import { settingDefault } from '@shared/settings'
import type { ViewSettings } from '../settings/viewStore'
import type { RepeatMode } from './traversal'

/**
 * The two transport settings that outlive a session.
 *
 * Shuffle and repeat are modes rather than actions — a player that forgot them
 * on restart would be one the user has to re-arm every launch. The shuffle
 * *seed* is deliberately not among them: design §5 rule 5 keeps traversal
 * transient in v1, so switching shuffle on after a restart reshuffles rather
 * than resurrecting last week's sequence, which is also the only honest thing
 * to do when the library may have been rescanned in between.
 *
 * View-scoped rather than durable: which order you left the transport in is a
 * fact about this window on this machine, and it has no business in a file that
 * is meant to survive being copied between machines.
 *
 * What is left of this module is two key names and the shape the controller
 * wants them in. The guard, the JSON and the field-by-field degrading are gone
 * — W8-3 moved the first two into the view store and the third into the two
 * descriptors, which is why `{"repeat":"sideways","shuffle":true}` still yields
 * a kept shuffle and a reset repeat: they are separate keys now, and one being
 * rejected cannot take the other with it.
 */

export const TRANSPORT_REPEAT_KEY = 'playback.repeat'
export const TRANSPORT_SHUFFLE_KEY = 'playback.shuffle'

export interface TransportPreferences {
  repeat: RepeatMode
  shuffle: boolean
}

export function defaultTransportPreferences(): TransportPreferences {
  return {
    repeat: settingDefault<RepeatMode>(TRANSPORT_REPEAT_KEY),
    shuffle: settingDefault<boolean>(TRANSPORT_SHUFFLE_KEY)
  }
}

export function readTransportPreferences(settings?: ViewSettings): TransportPreferences {
  if (!settings) return defaultTransportPreferences()
  return {
    repeat: settings.get<RepeatMode>(TRANSPORT_REPEAT_KEY),
    shuffle: settings.get<boolean>(TRANSPORT_SHUFFLE_KEY)
  }
}

export function writeTransportPreferences(
  settings: ViewSettings | undefined,
  preferences: TransportPreferences
): void {
  settings?.set(TRANSPORT_REPEAT_KEY, preferences.repeat)
  settings?.set(TRANSPORT_SHUFFLE_KEY, preferences.shuffle)
}
