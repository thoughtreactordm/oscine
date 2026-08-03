/**
 * Which key gets used, and the one case that has a wrong answer available.
 *
 * The wrong answer is falling back to the shipped pair when an operator has
 * half-filled the override: it works, silently, against a key they believed they
 * had replaced. Everything else here is bookkeeping around that.
 */

import { describe, expect, it } from 'vitest'
import { LASTFM_API_KEY, LASTFM_API_SECRET } from '../../../src/shared/settings'
import {
  missingAppKeyMessage,
  resolveLastfmAppKey,
  SHIPPED_LASTFM_API_KEY,
  SHIPPED_LASTFM_API_SECRET,
  type AppKeySettingsSource
} from '../../../src/main/scrobble/lastfm/appKey'

function settings(apiKey: string, apiSecret: string): AppKeySettingsSource {
  return {
    get: <T>(key: string): T => {
      if (key === LASTFM_API_KEY) return apiKey as T
      if (key === LASTFM_API_SECRET) return apiSecret as T
      throw new RangeError(`unexpected key: ${key}`)
    }
  }
}

describe('the shipped pair', () => {
  /**
   * That a release ships a usable key is an acceptance criterion, not a detail.
   *
   * A build with these blanked still compiles, still passes every other test in
   * this file, and connects for nobody who has not registered their own
   * application — which is precisely the failure that would ship unnoticed.
   */
  it('is configured, so this build can connect out of the box', () => {
    expect(SHIPPED_LASTFM_API_KEY).toMatch(/^[0-9a-f]{32}$/)
    expect(SHIPPED_LASTFM_API_SECRET).toMatch(/^[0-9a-f]{32}$/)
    expect(SHIPPED_LASTFM_API_KEY).not.toBe(SHIPPED_LASTFM_API_SECRET)
  })
})

describe('resolveLastfmAppKey', () => {
  it('prefers a complete override', () => {
    expect(resolveLastfmAppKey(settings('mine', 'also-mine'))).toEqual({
      apiKey: 'mine',
      apiSecret: 'also-mine',
      fromOverride: true
    })
  })

  it('trims what was pasted', () => {
    expect(resolveLastfmAppKey(settings('  mine  ', '\tsecret\n'))).toMatchObject({
      apiKey: 'mine',
      apiSecret: 'secret'
    })
  })

  it.each([
    ['a key with no secret', 'mine', ''],
    ['a secret with no key', '', 'also-mine'],
    ['whitespace standing in for a value', 'mine', '   ']
  ])('treats %s as no key at all, never as the shipped pair', (_case, apiKey, apiSecret) => {
    expect(resolveLastfmAppKey(settings(apiKey, apiSecret))).toBeNull()
  })

  it('falls back to the shipped pair when both fields are empty', () => {
    // The overwhelmingly common case: nobody has typed anything into Settings.
    expect(resolveLastfmAppKey(settings('', ''))).toEqual({
      apiKey: SHIPPED_LASTFM_API_KEY,
      apiSecret: SHIPPED_LASTFM_API_SECRET,
      fromOverride: false
    })
  })
})

describe('missingAppKeyMessage', () => {
  it('points at the empty field when the operator was mid-paste', () => {
    expect(missingAppKeyMessage(settings('mine', ''))).toMatch(/both/i)
    expect(missingAppKeyMessage(settings('mine', ''))).toMatch(/Settings/)
  })

  it('says the build has none when nothing was entered', () => {
    expect(missingAppKeyMessage(settings('', ''))).toMatch(/no Last\.fm application key/i)
  })
})
