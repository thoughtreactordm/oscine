import { describe, expect, it } from 'vitest'
import type { LayoutStorage } from '../../../src/renderer/panels/columnLayout'
import {
  ALBUM_ART_SIZES,
  ALBUM_ART_SIZE_KEYS,
  createGroupingPreference,
  defaultGroupingPreference,
  normalizeGroupingPreference
} from '../../../src/renderer/panels/groupingLayout'

/** Records what was written, so persistence is checked rather than assumed. */
function memoryStorage(initial: string | null = null): LayoutStorage & { value: string | null } {
  return {
    value: initial,
    read(): string | null {
      return this.value
    },
    write(next: string): void {
      this.value = next
    }
  }
}

describe('normalizeGroupingPreference', () => {
  it('defaults to grouped with small sleeves', () => {
    expect(defaultGroupingPreference()).toEqual({ enabled: true, artSize: 'small' })
  })

  it('keeps a valid stored preference', () => {
    expect(normalizeGroupingPreference({ enabled: false, artSize: 'large' })).toEqual({
      enabled: false,
      artSize: 'large'
    })
  })

  it.each([null, undefined, 42, 'large', [], true])('falls back for %p', (value) => {
    expect(normalizeGroupingPreference(value)).toEqual(defaultGroupingPreference())
  })

  /**
   * Field by field, so a blob from a version that adds a third setting still
   * yields the two this version knows — and one bad field does not discard a
   * good one beside it.
   */
  it('repairs a field without discarding the others', () => {
    expect(normalizeGroupingPreference({ enabled: false, artSize: 'enormous' })).toEqual({
      enabled: false,
      artSize: 'small'
    })
    expect(normalizeGroupingPreference({ enabled: 'yes', artSize: 'medium' })).toEqual({
      enabled: true,
      artSize: 'medium'
    })
    expect(normalizeGroupingPreference({ artSize: 'large', future: 'ignored' })).toEqual({
      enabled: true,
      artSize: 'large'
    })
  })
})

describe('createGroupingPreference', () => {
  it('starts from the defaults with no stored value', () => {
    const grouping = createGroupingPreference()
    expect(grouping.enabled.value).toBe(true)
    expect(grouping.artSize.value).toBe('small')
    expect(grouping.artPx.value).toBe(ALBUM_ART_SIZES.small.art)
    expect(grouping.rowPx.value).toBe(ALBUM_ART_SIZES.small.row)
  })

  it('restores what was stored', () => {
    const storage = memoryStorage(JSON.stringify({ enabled: false, artSize: 'large' }))
    const grouping = createGroupingPreference({ storage })
    expect(grouping.enabled.value).toBe(false)
    expect(grouping.artSize.value).toBe('large')
    expect(grouping.rowPx.value).toBe(ALBUM_ART_SIZES.large.row)
  })

  it('survives a blob that is not JSON at all', () => {
    const grouping = createGroupingPreference({ storage: memoryStorage('{ not json') })
    expect(grouping.enabled.value).toBe(true)
    expect(grouping.artSize.value).toBe('small')
  })

  it('persists a toggle', () => {
    const storage = memoryStorage()
    const grouping = createGroupingPreference({ storage })

    grouping.toggleEnabled()
    expect(grouping.enabled.value).toBe(false)
    expect(JSON.parse(storage.value!)).toEqual({ enabled: false, artSize: 'small' })

    grouping.toggleEnabled()
    expect(grouping.enabled.value).toBe(true)
  })

  it.each(ALBUM_ART_SIZE_KEYS)('persists the %s sleeve size and its geometry', (size) => {
    const storage = memoryStorage()
    const grouping = createGroupingPreference({ storage })

    grouping.setArtSize(size)
    expect(grouping.artSize.value).toBe(size)
    expect(grouping.artPx.value).toBe(ALBUM_ART_SIZES[size].art)
    expect(grouping.rowPx.value).toBe(ALBUM_ART_SIZES[size].row)
    expect(JSON.parse(storage.value!).artSize).toBe(size)
  })

  /**
   * Otherwise choosing a size while headers are hidden changes nothing on
   * screen, which reads as a broken control rather than as a setting saved for
   * later.
   */
  it('turns grouping on when a size is chosen', () => {
    const grouping = createGroupingPreference({ storage: memoryStorage() })
    grouping.setEnabled(false)

    grouping.setArtSize('medium')

    expect(grouping.enabled.value).toBe(true)
    expect(grouping.artSize.value).toBe('medium')
  })

  it('ignores a size it does not know', () => {
    const grouping = createGroupingPreference({ storage: memoryStorage() })
    grouping.setArtSize('enormous' as never)
    expect(grouping.artSize.value).toBe('small')
  })

  it('resets to the defaults', () => {
    const storage = memoryStorage()
    const grouping = createGroupingPreference({ storage })
    grouping.setArtSize('large')
    grouping.setEnabled(false)

    grouping.reset()

    expect(grouping.enabled.value).toBe(true)
    expect(grouping.artSize.value).toBe('small')
    expect(JSON.parse(storage.value!)).toEqual(defaultGroupingPreference())
  })

  it('works without storage at all', () => {
    const grouping = createGroupingPreference()
    expect(() => grouping.setArtSize('large')).not.toThrow()
    expect(grouping.artSize.value).toBe('large')
  })

  /** Every header must be tall enough to hold its sleeve and some padding. */
  it('gives every size a row taller than its sleeve', () => {
    for (const size of ALBUM_ART_SIZE_KEYS) {
      expect(ALBUM_ART_SIZES[size].row).toBeGreaterThan(ALBUM_ART_SIZES[size].art)
    }
  })
})
