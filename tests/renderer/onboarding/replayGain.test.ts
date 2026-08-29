import { describe, expect, it } from 'vitest'
import { AUDIO_REPLAY_GAIN_MODE } from '../../../src/shared/settings'
import {
  replayGainIsOn,
  replayGainModeFromEnabled,
  replayGainToggleDescriptor
} from '../../../src/renderer/onboarding/replayGain'

/**
 * D-ONB-5: the wizard switch is off ↔ `track`, and it does not invent a second
 * control — the descriptor stays the settings view's, with `kind: 'toggle'`.
 */

describe('replayGain wizard binding', () => {
  it('treats anything but off as on, so a stored album mode is not shown as off', () => {
    expect(replayGainIsOn('off')).toBe(false)
    expect(replayGainIsOn('track')).toBe(true)
    expect(replayGainIsOn('album')).toBe(true)
    expect(replayGainIsOn(undefined)).toBe(true)
  })

  it('writes only off and track', () => {
    expect(replayGainModeFromEnabled(false)).toBe('off')
    expect(replayGainModeFromEnabled(true)).toBe('track')
  })

  it('keeps the registry label and help, swapping only the control kind', () => {
    const drawn = replayGainToggleDescriptor(AUDIO_REPLAY_GAIN_MODE)
    expect(drawn.label).toBe(AUDIO_REPLAY_GAIN_MODE.label)
    expect(drawn.help).toBe(AUDIO_REPLAY_GAIN_MODE.help)
    expect(drawn.control).toEqual({ kind: 'toggle' })
    expect(AUDIO_REPLAY_GAIN_MODE.control?.kind).toBe('select')
  })
})
