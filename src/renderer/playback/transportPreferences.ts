import { ref, type Ref } from 'vue'
import { settingDefault } from '@shared/settings'
import type { SettingsReader } from '../settings/reader'
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
 * What is left of this module is two key names and the binding the controller
 * wants them in. The guard, the JSON and the field-by-field degrading are gone
 * — W8-3 moved the first two into the view store and the third into the two
 * descriptors, which is why `{"repeat":"sideways","shuffle":true}` still yields
 * a kept shuffle and a reset repeat: they are separate keys now, and one being
 * rejected cannot take the other with it.
 *
 * W8-4 took the read/write pair that used to live here. A read at construction
 * and a write after every change is a snapshot, and a snapshot is what "settings
 * apply immediately, everywhere" rules out: the settings view can set repeat,
 * and the transport has to already be showing it.
 */

export const TRANSPORT_REPEAT_KEY = 'playback.repeat'
export const TRANSPORT_SHUFFLE_KEY = 'playback.shuffle'

export interface TransportPreferences {
  repeat: RepeatMode
  shuffle: boolean
}

/** The two bindings, writable: assigning one persists it. */
export interface TransportBinding {
  repeat: Ref<RepeatMode>
  shuffle: Ref<boolean>
}

export function defaultTransportPreferences(): TransportPreferences {
  return {
    repeat: settingDefault<RepeatMode>(TRANSPORT_REPEAT_KEY),
    shuffle: settingDefault<boolean>(TRANSPORT_SHUFFLE_KEY)
  }
}

/**
 * Bind the transport to the two keys, or to nothing.
 *
 * Omitting the store is a supported configuration rather than a degraded one —
 * the modes simply last for the session, which is what a test that does not care
 * about persistence wants. The two shapes are interchangeable because a
 * `WritableComputedRef` *is* a `Ref`: the controller assigns to `.value` either
 * way and never learns which it got.
 */
export function bindTransportPreferences(settings?: SettingsReader): TransportBinding {
  if (!settings) {
    const defaults = defaultTransportPreferences()
    return { repeat: ref(defaults.repeat), shuffle: ref(defaults.shuffle) }
  }
  return {
    repeat: settings.value<RepeatMode>(TRANSPORT_REPEAT_KEY),
    shuffle: settings.value<boolean>(TRANSPORT_SHUFFLE_KEY)
  }
}
