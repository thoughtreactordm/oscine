import { describe, expect, it } from 'vitest'
import { settingsInScope } from '@shared/settings'
import { migrateViewStoragePrefix } from '../../../src/renderer/settings/viewStorageMigration'
import {
  LEGACY_VIEW_STORAGE_PREFIX,
  VIEW_STORAGE_PREFIX,
  memoryViewStorage
} from '../../../src/renderer/settings/viewStore'

/**
 * The upgrade path off the pre-rename `fermata.view.*` namespace.
 *
 * The thing under test is that an operator who ran a Fermata build finds their
 * pane sizes, tabs and column layouts where they left them after the rename to
 * Oscine — the store reads a different prefix now, so anything not moved across
 * is silently a default.
 */

const VIEW = settingsInScope('view')
const KEY = VIEW[0].key
const OTHER = VIEW[1].key

describe('migrating the view-store prefix onto the current name', () => {
  it('moves a pre-rename entry across and clears the old one', () => {
    const storage = memoryViewStorage({
      [LEGACY_VIEW_STORAGE_PREFIX + KEY]: '{"value":1,"version":1}'
    })
    expect(migrateViewStoragePrefix(storage)).toContain(KEY)
    expect(storage.read(VIEW_STORAGE_PREFIX + KEY)).toBe('{"value":1,"version":1}')
    expect(storage.read(LEGACY_VIEW_STORAGE_PREFIX + KEY)).toBeNull()
  })

  it('keeps a value already at the current prefix rather than clobbering it', () => {
    const storage = memoryViewStorage({
      [LEGACY_VIEW_STORAGE_PREFIX + KEY]: '{"value":"old","version":1}',
      [VIEW_STORAGE_PREFIX + KEY]: '{"value":"new","version":1}'
    })
    migrateViewStoragePrefix(storage)
    expect(storage.read(VIEW_STORAGE_PREFIX + KEY)).toBe('{"value":"new","version":1}')
    // The stale legacy key still goes, so it is not re-examined every launch.
    expect(storage.read(LEGACY_VIEW_STORAGE_PREFIX + KEY)).toBeNull()
  })

  it('is a no-op on a second run', () => {
    const storage = memoryViewStorage({
      [LEGACY_VIEW_STORAGE_PREFIX + KEY]: '{"value":1,"version":1}'
    })
    expect(migrateViewStoragePrefix(storage)).toEqual([KEY])
    const before = storage.writes
    expect(migrateViewStoragePrefix(storage)).toEqual([])
    expect(storage.writes).toBe(before)
  })

  it('does nothing for a profile that never had the old prefix', () => {
    const storage = memoryViewStorage({ [VIEW_STORAGE_PREFIX + KEY]: '{"value":1,"version":1}' })
    expect(migrateViewStoragePrefix(storage)).toEqual([])
    expect(storage.writes).toBe(0)
  })

  it('leaves a fermata.view key it has no descriptor for untouched', () => {
    // Same rule the store follows: an entry with no descriptor is one a
    // neighbouring build owns, not this one's to move.
    const storage = memoryViewStorage({
      'fermata.view.someNeighbourKey': '{"value":1,"version":1}'
    })
    expect(migrateViewStoragePrefix(storage)).toEqual([])
    expect(storage.read('fermata.view.someNeighbourKey')).toBe('{"value":1,"version":1}')
  })

  it('carries a whole profile across in one pass', () => {
    const storage = memoryViewStorage({
      [LEGACY_VIEW_STORAGE_PREFIX + KEY]: '{"value":1,"version":1}',
      [LEGACY_VIEW_STORAGE_PREFIX + OTHER]: '{"value":2,"version":1}'
    })
    expect(migrateViewStoragePrefix(storage)).toEqual(expect.arrayContaining([KEY, OTHER]))
    expect(storage.read(VIEW_STORAGE_PREFIX + OTHER)).toBe('{"value":2,"version":1}')
  })

  it('runs with no storage at all', () => {
    expect(migrateViewStoragePrefix(undefined)).toEqual([])
  })
})
