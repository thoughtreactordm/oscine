import { describe, expect, it } from 'vitest'
import { settingDefault } from '@shared/settings'
import {
  ALBUM_ART_SIZES,
  ALBUM_ART_SIZE_KEYS,
  createGroupingPreference,
  GROUPING_ART_SIZE_KEY,
  GROUPING_ENABLED_KEY
} from '../../../src/renderer/panels/groupingLayout'
import { createViewSettings, VIEW_STORAGE_PREFIX } from '../../../src/renderer/settings/viewStore'
import { storedValue, viewSettingsFixture } from '../settings/fixture'

/**
 * The two settings are two keys now, so what used to be one
 * `normalizeGroupingPreference` over a `{enabled, artSize}` blob is two
 * descriptors — which is what makes "one bad field does not discard a good one"
 * structural rather than something this module has to remember to do. The
 * degrading itself is tested against the descriptors in `tests/shared/settings`.
 *
 * What is left here is the geometry, which is the only part of grouping that is
 * a renderer concern at all.
 */
function grouping(seed: Readonly<Record<string, unknown>> = {}) {
  const fixture = viewSettingsFixture(seed)
  return { ...fixture, grouping: createGroupingPreference({ settings: fixture.settings }) }
}

describe('createGroupingPreference', () => {
  it('starts from the registry s defaults with no stored value', () => {
    const { grouping: preference } = grouping()
    expect(preference.enabled.value).toBe(settingDefault(GROUPING_ENABLED_KEY))
    expect(preference.artSize.value).toBe(settingDefault(GROUPING_ART_SIZE_KEY))
    expect(preference.artPx.value).toBe(ALBUM_ART_SIZES.small.art)
    expect(preference.rowPx.value).toBe(ALBUM_ART_SIZES.small.row)
  })

  it('restores what was stored', () => {
    const { grouping: preference } = grouping({
      [GROUPING_ENABLED_KEY]: false,
      [GROUPING_ART_SIZE_KEY]: 'large'
    })
    expect(preference.enabled.value).toBe(false)
    expect(preference.artSize.value).toBe('large')
    expect(preference.rowPx.value).toBe(ALBUM_ART_SIZES.large.row)
  })

  it('survives an entry that is not JSON at all', () => {
    const fixture = viewSettingsFixture()
    fixture.storage.write(VIEW_STORAGE_PREFIX + GROUPING_ART_SIZE_KEY, '{ not json')
    const preference = createGroupingPreference({
      settings: createViewSettings({ storage: fixture.storage, debounceMs: 0 })
    })
    expect(preference.enabled.value).toBe(true)
    expect(preference.artSize.value).toBe('small')
  })

  it('persists a toggle', () => {
    const { grouping: preference, storage } = grouping()

    preference.toggleEnabled()
    expect(preference.enabled.value).toBe(false)
    expect(storedValue(storage, GROUPING_ENABLED_KEY)).toBe(false)

    preference.toggleEnabled()
    expect(preference.enabled.value).toBe(true)
  })

  it.each(ALBUM_ART_SIZE_KEYS)('persists the %s sleeve size and its geometry', (size) => {
    const { grouping: preference, storage } = grouping()

    preference.setArtSize(size)
    expect(preference.artSize.value).toBe(size)
    expect(preference.artPx.value).toBe(ALBUM_ART_SIZES[size].art)
    expect(preference.rowPx.value).toBe(ALBUM_ART_SIZES[size].row)

    // Asserted through a second store rather than against the stored entry:
    // choosing the size that is already the default writes nothing, which is
    // the point of forgetting an unoverridden key rather than storing it.
    const next = createGroupingPreference({
      settings: createViewSettings({ storage, debounceMs: 0 })
    })
    expect(next.artSize.value).toBe(size)
  })

  /**
   * Otherwise choosing a size while headers are hidden changes nothing on
   * screen, which reads as a broken control rather than as a setting saved for
   * later.
   */
  it('turns grouping on when a size is chosen', () => {
    const { grouping: preference } = grouping()
    preference.setEnabled(false)

    preference.setArtSize('medium')

    expect(preference.enabled.value).toBe(true)
    expect(preference.artSize.value).toBe('medium')
  })

  it('ignores a size it does not know', () => {
    const { grouping: preference } = grouping()
    preference.setArtSize('enormous' as never)
    expect(preference.artSize.value).toBe('small')
  })

  it('forgets both keys on reset rather than storing today s defaults', () => {
    const { grouping: preference, storage } = grouping()
    preference.setArtSize('large')
    preference.setEnabled(false)

    preference.reset()

    expect(preference.enabled.value).toBe(true)
    expect(preference.artSize.value).toBe('small')
    expect(storedValue(storage, GROUPING_ENABLED_KEY)).toBeNull()
    expect(storedValue(storage, GROUPING_ART_SIZE_KEY)).toBeNull()
  })

  it('works without storage at all', () => {
    const preference = createGroupingPreference({
      settings: createViewSettings({ debounceMs: 0 })
    })
    expect(() => preference.setArtSize('large')).not.toThrow()
    expect(preference.artSize.value).toBe('large')
  })

  /** Every header must be tall enough to hold its sleeve and some padding. */
  it('gives every size a row taller than its sleeve', () => {
    for (const size of ALBUM_ART_SIZE_KEYS) {
      expect(ALBUM_ART_SIZES[size].row).toBeGreaterThan(ALBUM_ART_SIZES[size].art)
    }
  })
})
