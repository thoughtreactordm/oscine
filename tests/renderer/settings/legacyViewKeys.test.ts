import { describe, expect, it } from 'vitest'
import type { StoredColumnLayout, TabSession } from '@shared/settings'
import {
  absorbLegacyViewKeys,
  LEGACY_VIEW_KEYS
} from '../../../src/renderer/settings/legacyViewKeys'
import {
  createViewSettings,
  memoryViewStorage,
  VIEW_STORAGE_PREFIX,
  type ViewStorageArea
} from '../../../src/renderer/settings/viewStore'

/**
 * The upgrade path off the five hand-rolled keys.
 *
 * Every fixture below is the shape the module that owned it actually wrote —
 * `JSON.stringify` of its own state object, key for key — because the thing
 * being tested is that an operator who upgrades finds their pane widths, open
 * tabs, column layout and transport modes where they left them. A fixture
 * invented to match the new descriptor would prove nothing.
 */

function upgrade(seed: Readonly<Record<string, string>>) {
  const storage = memoryViewStorage(seed)
  const settings = createViewSettings({ storage, debounceMs: 0 })
  const cleared = absorbLegacyViewKeys(settings, storage)
  return { storage, settings, cleared }
}

function stored(storage: ViewStorageArea, key: string): unknown {
  const raw = storage.read(VIEW_STORAGE_PREFIX + key)
  return raw === null ? null : (JSON.parse(raw) as { value: unknown }).value
}

describe('fermata.transport', () => {
  it('keeps the transport modes', () => {
    const { settings, storage } = upgrade({
      'fermata.transport': '{"repeat":"all","shuffle":true}'
    })
    expect(settings.get('playback.repeat')).toBe('all')
    expect(settings.get('playback.shuffle')).toBe(true)
    expect(stored(storage, 'playback.repeat')).toBe('all')
  })

  /**
   * The two fields are two keys now, which is what "degrades field by field"
   * became: one being rejected cannot take the other with it.
   */
  it('keeps the good field when the other is nonsense', () => {
    const { settings } = upgrade({
      'fermata.transport': '{"repeat":"sideways","shuffle":true}'
    })
    expect(settings.get('playback.repeat')).toBe('off')
    expect(settings.get('playback.shuffle')).toBe(true)
  })

  it('leaves a missing field at its default without a notice', () => {
    const { settings } = upgrade({ 'fermata.transport': '{"repeat":"one"}' })
    expect(settings.get('playback.repeat')).toBe('one')
    expect(settings.get('playback.shuffle')).toBe(false)
    expect(settings.notices.value).toEqual([])
  })
})

describe('fermata.shellLayout.v1', () => {
  it('keeps the pane sizes the frame was dragged to', () => {
    const { settings } = upgrade({
      'fermata.shellLayout.v1':
        '{"paneSizes":{"shell.sidebar":412,"sources.artists":198,"deck.queue":260}}'
    })
    expect(settings.get('view.shellPaneSizes')).toEqual({
      'shell.sidebar': 412,
      'sources.artists': 198,
      // A pane this build does not know is a pane a neighbouring build owns.
      'deck.queue': 260
    })
  })
})

describe('fermata.trackColumns.v1', () => {
  it('keeps the order, the hidden set and the widths', () => {
    const { settings } = upgrade({
      'fermata.trackColumns.v1':
        '{"order":["title","artist","trackNo","album","durationSec","albumArtist","discNo","year","codec","sampleRateHz","bitDepth","channels","encodedBytes"],"hidden":["discNo","year","codec","sampleRateHz","bitDepth","channels","encodedBytes"],"widths":{"title":420,"artist":180}}'
    })
    const layout = settings.get<StoredColumnLayout>('view.trackColumns')
    expect(layout.order.slice(0, 3)).toEqual(['title', 'artist', 'trackNo'])
    expect(layout.hidden).toContain('year')
    expect(layout.widths).toEqual({ title: 420, artist: 180 })
  })
})

describe('fermata.trackGrouping.v1', () => {
  it('keeps both fields', () => {
    const { settings } = upgrade({
      'fermata.trackGrouping.v1': '{"enabled":false,"artSize":"large"}'
    })
    expect(settings.get('view.trackGroupingEnabled')).toBe(false)
    expect(settings.get('view.trackGroupingArtSize')).toBe('large')
  })

  it('repairs one field without discarding the other', () => {
    const { settings } = upgrade({
      'fermata.trackGrouping.v1': '{"enabled":false,"artSize":"enormous"}'
    })
    expect(settings.get('view.trackGroupingEnabled')).toBe(false)
    expect(settings.get('view.trackGroupingArtSize')).toBe('small')
  })
})

describe('fermata.playlistTabs.v1', () => {
  it('keeps the open tabs and the viewed one', () => {
    const { settings } = upgrade({
      'fermata.playlistTabs.v1': '{"openIds":[4,1,9],"viewedId":1}'
    })
    expect(settings.get<TabSession>('view.playlistTabs')).toEqual({
      openIds: [4, 1, 9],
      viewedId: 1
    })
  })
})

describe('fermata.podcastSession.v1', () => {
  it('keeps the open shows and drops the scroll target', () => {
    const { settings } = upgrade({
      'fermata.podcastSession.v1': '{"openIds":[3,7],"viewedId":7}'
    })
    expect(settings.get<TabSession>('view.podcastTabs')).toEqual({
      openIds: [3, 7],
      viewedId: 7
    })
  })
})

describe('absorbing as a whole', () => {
  it('takes a whole profile in one pass', () => {
    const { settings, cleared } = upgrade({
      'fermata.transport': '{"repeat":"one","shuffle":true}',
      'fermata.shellLayout.v1': '{"paneSizes":{"shell.sidebar":400}}',
      'fermata.trackColumns.v1': '{"order":["title"],"hidden":[],"widths":{}}',
      'fermata.trackGrouping.v1': '{"enabled":false,"artSize":"medium"}',
      'fermata.playlistTabs.v1': '{"openIds":[2],"viewedId":2}',
      'fermata.podcastSession.v1': '{"openIds":[5],"viewedId":5}'
    })
    expect(cleared).toHaveLength(LEGACY_VIEW_KEYS.length)
    expect(settings.get('playback.repeat')).toBe('one')
    expect(settings.get('view.trackGroupingArtSize')).toBe('medium')
  })

  it('clears the legacy keys, so a second run is a no-op', () => {
    const storage = memoryViewStorage({ 'fermata.transport': '{"repeat":"all","shuffle":false}' })
    const settings = createViewSettings({ storage, debounceMs: 0 })

    expect(absorbLegacyViewKeys(settings, storage)).toEqual(['fermata.transport'])
    expect(storage.read('fermata.transport')).toBeNull()

    const before = storage.writes
    expect(absorbLegacyViewKeys(settings, storage)).toEqual([])
    expect(storage.writes).toBe(before)
  })

  it('does nothing at all for a profile that never had them', () => {
    const { cleared, storage } = upgrade({})
    expect(cleared).toEqual([])
    expect(storage.writes).toBe(0)
  })

  /**
   * An operator who runs this build, then an older one that rewrites its own
   * key, should keep what this build knows rather than have it clobbered by the
   * older shape.
   */
  it('does not overwrite a key the view store already holds', () => {
    const { settings } = upgrade({
      'fermata.transport': '{"repeat":"all","shuffle":true}',
      [VIEW_STORAGE_PREFIX + 'playback.repeat']: '{"value":"one","version":1}'
    })
    expect(settings.get('playback.repeat')).toBe('one')
    expect(settings.get('playback.shuffle')).toBe(true)
  })

  it('clears a blob that is not JSON rather than retrying it every launch', () => {
    const { settings, storage, cleared } = upgrade({ 'fermata.transport': '{not json' })
    expect(cleared).toEqual(['fermata.transport'])
    expect(storage.read('fermata.transport')).toBeNull()
    expect(settings.get('playback.repeat')).toBe('off')
  })

  it('runs with no storage at all', () => {
    const settings = createViewSettings({ debounceMs: 0 })
    expect(absorbLegacyViewKeys(settings, undefined)).toEqual([])
  })
})
