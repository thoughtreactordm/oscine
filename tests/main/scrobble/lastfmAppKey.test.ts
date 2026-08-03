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

const shipped = SHIPPED_LASTFM_API_KEY !== '' && SHIPPED_LASTFM_API_SECRET !== ''

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
    const resolved = resolveLastfmAppKey(settings('', ''))
    if (shipped) {
      expect(resolved).toEqual({
        apiKey: SHIPPED_LASTFM_API_KEY,
        apiSecret: SHIPPED_LASTFM_API_SECRET,
        fromOverride: false
      })
    } else {
      // This build has no registered application yet — see `appKey.ts`. The
      // assertion is conditional rather than absent so that the day the pair is
      // filled in, this test starts checking the other branch instead of
      // quietly needing an edit.
      expect(resolved).toBeNull()
    }
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
