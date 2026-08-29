/**
 * D-ONB-5: the wizard's ReplayGain control is a toggle, bound to
 * `audio.replayGainMode` as off ↔ `track`.
 *
 * The registry control is a three-way select (off / track / album). First-run
 * does not ask about album mode; preamp, fallback and compute-when-missing
 * stay off this surface entirely. Re-running with `album` already stored shows
 * the toggle on and is left alone until the operator flips it.
 */

import type { ReplayGainMode, SettingDescriptor } from '@shared/settings'

export function replayGainIsOn(mode: unknown): boolean {
  return mode !== 'off'
}

export function replayGainModeFromEnabled(enabled: boolean): ReplayGainMode {
  return enabled ? 'track' : 'off'
}

/** Same descriptor, drawn as a switch so the wizard does not grow a second widget. */
export function replayGainToggleDescriptor(source: SettingDescriptor): SettingDescriptor {
  return { ...source, control: { kind: 'toggle' } }
}
