import { describe, expect, it } from 'vitest'
import {
  getSetting,
  resolveDefault,
  validateValue,
  type SettingDescriptor,
  type StoredColumnLayout,
  type TabSession
} from '@shared/settings'

/**
 * The normalize-on-read that five renderer modules each wrote for themselves,
 * now stated once per key.
 *
 * These are the tests those modules had. They read against the descriptor
 * rather than against a `parseXyz` because that is the point of W8-3: a stored
 * blob's shape is a property of the key, not of whichever module happens to
 * load it, and there is one answer for both processes to agree on.
 */

function descriptor(key: string): SettingDescriptor {
  const found = getSetting(key)
  if (!found) throw new Error(`no descriptor for ${key}`)
  return found
}

/** What the store would end up holding, notices and repairs included. */
function resolved<T>(key: string, raw: unknown): T {
  return validateValue(descriptor(key), raw).value as T
}

function fallsBack(key: string, raw: unknown): boolean {
  const result = validateValue(descriptor(key), raw)
  return result.notice !== null
}

describe('view.shellPaneSizes', () => {
  const KEY = 'view.shellPaneSizes'

  it('starts with no pane sized', () => {
    expect(resolveDefault(descriptor(KEY))).toEqual({})
  })

  it('drops sizes that are not usable numbers', () => {
    expect(resolved(KEY, { a: 'wide', b: Number.NaN, c: -20, d: 0, e: 300, f: null })).toEqual({
      e: 300
    })
  })

  it('rounds a fractional size rather than losing the pane', () => {
    // The resizer rounds everything it writes, so a fraction here came from a
    // hand edit or an older build — and the pixel it would have been rounded
    // to is a better answer than forgetting the pane.
    expect(resolved(KEY, { 'shell.sidebar': 320.4 })).toEqual({ 'shell.sidebar': 320 })
  })

  it('keeps a pane it has never heard of', () => {
    // A pane this build does not know is a pane a neighbouring build owns.
    expect(resolved(KEY, { 'deck.queue': 260 })).toEqual({ 'deck.queue': 260 })
  })

  it('falls back for a stored value of the wrong shape entirely', () => {
    for (const raw of [null, [1, 2, 3], 'wide', 42]) {
      expect(fallsBack(KEY, raw)).toBe(true)
      expect(resolved(KEY, raw)).toEqual({})
    }
  })
})

describe('view.trackColumns', () => {
  const KEY = 'view.trackColumns'

  /**
   * Null rather than an empty layout, because an empty `hidden` is a real
   * state — the operator showed every column — and must not be read as a fresh
   * profile, whose hidden set is the eight columns W4-1 shipped hidden.
   */
  it('is null until a layout has been configured', () => {
    expect(resolveDefault(descriptor(KEY))).toBeNull()
    expect(resolved(KEY, null)).toBeNull()
  })

  it('keeps the three lists as plain strings', () => {
    // Whether a string names a real column is a question about the catalogue,
    // which is renderer presentation data — `normalizeColumnLayout` answers it
    // at the point of use.
    expect(
      resolved<StoredColumnLayout>(KEY, {
        order: ['title', 'nonsense'],
        hidden: ['year'],
        widths: { title: 400 }
      })
    ).toEqual({ order: ['title', 'nonsense'], hidden: ['year'], widths: { title: 400 } })
  })

  it('repairs a field without discarding the others', () => {
    expect(resolved<StoredColumnLayout>(KEY, { order: 'title', widths: { title: 400 } })).toEqual({
      order: [],
      hidden: [],
      widths: { title: 400 }
    })
  })

  it('drops duplicates and non-strings from the two lists', () => {
    expect(
      resolved<StoredColumnLayout>(KEY, { order: ['title', 'title', 7, null, 'album'] })
    ).toEqual({ order: ['title', 'album'], hidden: [], widths: {} })
  })

  it('rounds a width and drops one that is not a finite number', () => {
    expect(
      resolved<StoredColumnLayout>(KEY, {
        widths: { title: 400.6, artist: 'wide', album: Number.NaN }
      })
    ).toEqual({ order: [], hidden: [], widths: { title: 401 } })
  })

  it('falls back for anything that is not a layout at all', () => {
    for (const raw of [42, 'columns', [], true]) {
      expect(fallsBack(KEY, raw)).toBe(true)
      expect(resolved(KEY, raw)).toBeNull()
    }
  })
})

/**
 * The stored tab set is operator-writable storage that outlives an upgrade, so
 * every one of these is about a value the reader must not trust. The bar is not
 * "does it round-trip" — it is "does a hand-edited or stale value degrade to no
 * tabs open", which is recoverable because the rail is right there.
 */
describe('view.playlistTabs', () => {
  const KEY = 'view.playlistTabs'

  it('is empty until something is open', () => {
    expect(resolveDefault(descriptor(KEY))).toEqual({ openIds: [], viewedId: null })
  })

  it('round-trips what it wrote', () => {
    const session: TabSession = { openIds: [4, 1, 9], viewedId: 1 }
    expect(resolved<TabSession>(KEY, JSON.parse(JSON.stringify(session)))).toEqual(session)
  })

  it('is empty for anything that is not an object of the right shape', () => {
    for (const raw of [null, 42, [1, 2, 3], 'tabs']) {
      expect(fallsBack(KEY, raw)).toBe(true)
      expect(resolved(KEY, raw)).toEqual({ openIds: [], viewedId: null })
    }
    expect(resolved(KEY, { openIds: '1,2' })).toEqual({ openIds: [], viewedId: null })
  })

  it('drops ids that are not ids', () => {
    expect(
      resolved<TabSession>(KEY, { openIds: [1, '2', null, 3.5, -4, 0, 5], viewedId: 5 })
    ).toEqual({ openIds: [1, 5], viewedId: 5 })
  })

  it('collapses duplicates, which would render one playlist as two tabs', () => {
    expect(resolved<TabSession>(KEY, { openIds: [7, 7, 2, 7], viewedId: 2 })).toEqual({
      openIds: [7, 2],
      viewedId: 2
    })
  })

  it('falls back to the first tab when the viewed one is not among them', () => {
    expect(resolved<TabSession>(KEY, { openIds: [3, 4], viewedId: 9 })).toEqual({
      openIds: [3, 4],
      viewedId: 3
    })
    expect(resolved<TabSession>(KEY, { openIds: [3, 4] })).toEqual({
      openIds: [3, 4],
      viewedId: 3
    })
  })

  it('views nothing when nothing is open', () => {
    expect(resolved<TabSession>(KEY, { openIds: [], viewedId: 6 })).toEqual({
      openIds: [],
      viewedId: null
    })
  })

  it('keeps the stored tab order, which is not the library order', () => {
    expect(resolved<TabSession>(KEY, { openIds: [9, 2, 5], viewedId: 5 }).openIds).toEqual([
      9, 2, 5
    ])
  })
})

describe('view.podcastTabs', () => {
  const KEY = 'view.podcastTabs'

  it('drops ids that are not usable row ids', () => {
    expect(resolved<TabSession>(KEY, { openIds: [3, '4', 0, -1, 8], viewedId: 8 })).toEqual({
      openIds: [3, 8],
      viewedId: 8
    })
  })

  it('collapses duplicate tabs', () => {
    expect(resolved<TabSession>(KEY, { openIds: [5, 5, 6], viewedId: 6 })).toEqual({
      openIds: [5, 6],
      viewedId: 6
    })
  })

  /**
   * Not the leftmost show, unlike Curate: null is Discover here, which is a
   * real tab rather than an empty strip.
   */
  it('forgets a viewed show that is not one of the open tabs', () => {
    expect(resolved<TabSession>(KEY, { openIds: [3, 4], viewedId: 9 })).toEqual({
      openIds: [3, 4],
      viewedId: null
    })
  })

  it('never restores a scroll target', () => {
    // A scroll target is a one-shot instruction to the show pane, not state.
    // Restoring one would yank the list on launch.
    const stored = resolved<TabSession>(KEY, {
      openIds: [3],
      viewedId: 3,
      focusEpisodeId: 91
    })
    expect(stored).toEqual({ openIds: [3], viewedId: 3 })
    expect('focusEpisodeId' in stored).toBe(false)
  })
})

describe('view.tunedeckOpen', () => {
  const KEY = 'view.tunedeckOpen'

  it('starts closed', () => {
    // A fresh profile has never asked for the deck, and a frame that opened one
    // unprompted would be displacing the library to show an empty pane.
    expect(resolveDefault(descriptor(KEY))).toBe(false)
  })

  it('restores an open deck', () => {
    expect(resolved<boolean>(KEY, true)).toBe(true)
  })

  it('falls back rather than coercing a value that is merely truthy', () => {
    // `'false'` is the one that matters: it is what a hand edit or a storage
    // layer that stringifies would leave behind, and coercing it would open the
    // deck to say the deck is closed.
    expect(fallsBack(KEY, 'false')).toBe(true)
    expect(resolved<boolean>(KEY, 'false')).toBe(false)
    expect(fallsBack(KEY, 1)).toBe(true)
  })
})
