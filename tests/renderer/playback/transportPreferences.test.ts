import { describe, expect, it } from 'vitest'
import {
  defaultTransportPreferences,
  readTransportPreferences,
  writeTransportPreferences,
  TRANSPORT_REPEAT_KEY,
  TRANSPORT_SHUFFLE_KEY
} from '../../../src/renderer/playback/transportPreferences'
import { storedValue, viewSettingsFixture } from '../settings/fixture'

/**
 * Shuffle and repeat are two view-scoped keys now rather than one blob, so the
 * degrading this file used to prove field by field is proved by the descriptors
 * instead — see `tests/shared/settings`. What remains is the shape the
 * controller wants them in, and the promise that a shuffle *sequence* is not
 * among them.
 */
describe('transport preferences', () => {
  it('survives a round trip', () => {
    const { settings } = viewSettingsFixture()
    writeTransportPreferences(settings, { repeat: 'one', shuffle: true })
    expect(readTransportPreferences(settings)).toEqual({ repeat: 'one', shuffle: true })
  })

  it('defaults to off with nothing stored', () => {
    const { settings } = viewSettingsFixture()
    expect(readTransportPreferences(settings)).toEqual({ repeat: 'off', shuffle: false })
    expect(readTransportPreferences(undefined)).toEqual(defaultTransportPreferences())
  })

  /** Not a copy of the two defaults — the registry is where they are stated. */
  it('takes its defaults from the registry', () => {
    const { settings } = viewSettingsFixture()
    expect(readTransportPreferences(settings)).toEqual(defaultTransportPreferences())
  })

  it('records no shuffle sequence', () => {
    // Design §5 rule 5 keeps traversal transient: switching shuffle on after a
    // restart reshuffles rather than resurrecting a sequence over a library
    // that may have been rescanned since.
    const { settings, storage } = viewSettingsFixture()
    writeTransportPreferences(settings, { repeat: 'all', shuffle: true })
    expect(storedValue(storage, TRANSPORT_REPEAT_KEY)).toBe('all')
    expect(storedValue(storage, TRANSPORT_SHUFFLE_KEY)).toBe(true)
    expect(storage.entries.size).toBe(2)
  })

  /**
   * Two keys rather than one blob is what makes this structural: the rejected
   * repeat cannot take the good shuffle with it, because they were never in the
   * same value.
   */
  it('degrades field by field rather than discarding the lot', () => {
    const { settings } = viewSettingsFixture({
      [TRANSPORT_REPEAT_KEY]: 'sideways',
      [TRANSPORT_SHUFFLE_KEY]: true
    })
    expect(readTransportPreferences(settings)).toEqual({ repeat: 'off', shuffle: true })
  })

  it('survives storage that is not preferences at all', () => {
    for (const stored of [null, 42, [], 'off', { repeat: 'one' }]) {
      const { settings } = viewSettingsFixture({
        [TRANSPORT_REPEAT_KEY]: stored,
        [TRANSPORT_SHUFFLE_KEY]: stored
      })
      expect(readTransportPreferences(settings)).toEqual(defaultTransportPreferences())
    }
  })

  it('runs unbound', () => {
    // Omitting the view store is a supported configuration, not a degraded one
    // — the modes simply last for the session.
    expect(() =>
      writeTransportPreferences(undefined, { repeat: 'all', shuffle: true })
    ).not.toThrow()
  })
})
