import { describe, expect, it } from 'vitest'
import { NETWORK_EXTERNAL_LOOKUPS_KEY, SETTINGS_REGISTRY, settingDefault } from '@shared/settings'
import { CONSENT_DENIED, createNetworkConsent } from '../../../src/main/net/consent'
import type { ConsentSettingsSource } from '../../../src/main/net/consent'

function settingsReading(values: Record<string, unknown>): ConsentSettingsSource {
  return { getAll: () => ({ values, stored: [], notices: [] }) as never }
}

describe('the network consent key', () => {
  /**
   * The single most important assertion in W7-6. Everything else is a way of
   * getting to it: with nothing configured, Oscine does not phone anyone.
   */
  it('defaults to off', () => {
    expect(settingDefault(NETWORK_EXTERNAL_LOOKUPS_KEY)).toBe(false)
  })

  it('is in the registry, under Network, with a toggle', () => {
    const descriptor = SETTINGS_REGISTRY.find((entry) => entry.key === NETWORK_EXTERNAL_LOOKUPS_KEY)
    expect(descriptor).toBeDefined()
    expect(descriptor?.category).toBe('network')
    expect(descriptor?.control).toEqual({ kind: 'toggle' })
    expect(descriptor?.internal).toBe(false)
  })

  /**
   * A profile import must not be a way to grant consent on a machine where
   * nobody was asked — see the note in `settings/network.ts`.
   */
  it('is not carried by the settings profile', () => {
    const descriptor = SETTINGS_REGISTRY.find((entry) => entry.key === NETWORK_EXTERNAL_LOOKUPS_KEY)
    expect(descriptor?.portable).toBe(false)
  })
})

describe('createNetworkConsent', () => {
  it('refuses when the key is absent', () => {
    expect(createNetworkConsent(settingsReading({})).granted()).toBe(false)
  })

  it('refuses anything that is not exactly true', () => {
    for (const value of [false, 0, 1, '', 'true', null, undefined, {}]) {
      const consent = createNetworkConsent(
        settingsReading({ [NETWORK_EXTERNAL_LOOKUPS_KEY]: value })
      )
      expect(consent.granted()).toBe(false)
    }
  })

  it('allows when the key is true', () => {
    const consent = createNetworkConsent(settingsReading({ [NETWORK_EXTERNAL_LOOKUPS_KEY]: true }))
    expect(consent.granted()).toBe(true)
  })

  /** "Re-enabling takes effect without a restart", as the card puts it. */
  it('reads the setting live rather than caching it', () => {
    const values: Record<string, unknown> = { [NETWORK_EXTERNAL_LOOKUPS_KEY]: false }
    const consent = createNetworkConsent(settingsReading(values))

    expect(consent.granted()).toBe(false)
    values[NETWORK_EXTERNAL_LOOKUPS_KEY] = true
    expect(consent.granted()).toBe(true)
    values[NETWORK_EXTERNAL_LOOKUPS_KEY] = false
    expect(consent.granted()).toBe(false)
  })

  it('CONSENT_DENIED never grants', () => {
    expect(CONSENT_DENIED.granted()).toBe(false)
  })
})
