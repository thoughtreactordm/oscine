import { describe, expect, it } from 'vitest'
import {
  bindTransportPreferences,
  defaultTransportPreferences,
  TRANSPORT_REPEAT_KEY,
  TRANSPORT_SHUFFLE_KEY
} from '../../../src/renderer/playback/transportPreferences'
import { storedValue, viewSettingsFixture } from '../settings/fixture'

/**
 * Shuffle and repeat are two view-scoped keys now rather than one blob, so the
 * degrading this file used to prove field by field is proved by the descriptors
 * instead — see `tests/shared/settings`. What remains is the shape the
 * controller wants them in, the promise that a shuffle *sequence* is not among
 * them, and — since W8-4 — that the shape is a binding rather than a copy.
 */
describe('transport preferences', () => {
  it('survives a round trip', () => {
    const { settings } = viewSettingsFixture()
    const before = bindTransportPreferences(settings)
    before.repeat.value = 'one'
    before.shuffle.value = true

    // A second binding over the same store is what a relaunch amounts to.
    const after = bindTransportPreferences(settings)
    expect({ repeat: after.repeat.value, shuffle: after.shuffle.value }).toEqual({
      repeat: 'one',
      shuffle: true
    })
  })

  it('defaults to off with nothing stored', () => {
    const bound = bindTransportPreferences(viewSettingsFixture().settings)
    expect({ repeat: bound.repeat.value, shuffle: bound.shuffle.value }).toEqual({
      repeat: 'off',
      shuffle: false
    })

    const unbound = bindTransportPreferences()
    expect({ repeat: unbound.repeat.value, shuffle: unbound.shuffle.value }).toEqual(
      defaultTransportPreferences()
    )
  })

  /** Not a copy of the two defaults — the registry is where they are stated. */
  it('takes its defaults from the registry', () => {
    const bound = bindTransportPreferences(viewSettingsFixture().settings)
    expect({ repeat: bound.repeat.value, shuffle: bound.shuffle.value }).toEqual(
      defaultTransportPreferences()
    )
  })

  it('records no shuffle sequence', () => {
    // Design §5 rule 5 keeps traversal transient: switching shuffle on after a
    // restart reshuffles rather than resurrecting a sequence over a library
    // that may have been rescanned since.
    const { settings, storage } = viewSettingsFixture()
    const transport = bindTransportPreferences(settings)
    transport.repeat.value = 'all'
    transport.shuffle.value = true

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
    const transport = bindTransportPreferences(settings)
    expect({ repeat: transport.repeat.value, shuffle: transport.shuffle.value }).toEqual({
      repeat: 'off',
      shuffle: true
    })
  })

  it('survives storage that is not preferences at all', () => {
    for (const stored of [null, 42, [], 'off', { repeat: 'one' }]) {
      const { settings } = viewSettingsFixture({
        [TRANSPORT_REPEAT_KEY]: stored,
        [TRANSPORT_SHUFFLE_KEY]: stored
      })
      const transport = bindTransportPreferences(settings)
      expect({ repeat: transport.repeat.value, shuffle: transport.shuffle.value }).toEqual(
        defaultTransportPreferences()
      )
    }
  })

  /**
   * The W8-4 property: this is a binding, not a snapshot.
   *
   * A settings view writing the key is the case that matters — the transport
   * showing "repeat off" while the store says "repeat all" is the bug the whole
   * card exists to prevent, and a `readTransportPreferences` at construction is
   * how it used to be guaranteed.
   */
  it('follows a change made somewhere else', () => {
    const { settings } = viewSettingsFixture()
    const transport = bindTransportPreferences(settings)

    settings.set(TRANSPORT_REPEAT_KEY, 'all')
    settings.set(TRANSPORT_SHUFFLE_KEY, true)

    expect(transport.repeat.value).toBe('all')
    expect(transport.shuffle.value).toBe(true)
  })

  it('runs unbound', () => {
    // Omitting the settings surface is a supported configuration, not a
    // degraded one — the modes simply last for the session.
    const transport = bindTransportPreferences()
    expect(() => {
      transport.repeat.value = 'all'
      transport.shuffle.value = true
    }).not.toThrow()
    expect(transport.repeat.value).toBe('all')
  })
})
