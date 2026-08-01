import { describe, expect, it } from 'vitest'
import type { StoredColumnLayout } from '@shared/settings'
import {
  createColumnLayout,
  defaultColumnLayout,
  isSortableColumn,
  normalizeColumnLayout,
  TRACK_COLUMNS,
  TRACK_COLUMNS_KEY,
  type TrackColumnKey
} from '../../../src/renderer/panels/columnLayout'
import { createViewSettings } from '../../../src/renderer/settings/viewStore'
import { viewSettingsFixture } from '../settings/fixture'
import { TRACK_SORT_COLUMNS } from '../../../src/shared/library'

/**
 * The column layout, which is the one piece of panel state that has to survive
 * the process.
 *
 * The interesting cases are all about coming *back*: what a stale, truncated or
 * hand-edited blob does to a table that has no other way to get its columns
 * back. Which of those a stored blob even *is* — three lists of strings and
 * numbers — is now the descriptor's answer and is tested in
 * `tests/shared/viewSettings`; what stays here is every rule that needs the
 * catalogue below it.
 */
function stored(layout: Partial<StoredColumnLayout>): StoredColumnLayout {
  return { order: [], hidden: [], widths: {}, ...layout }
}

function columnLayout(seed?: Partial<StoredColumnLayout>) {
  const fixture = viewSettingsFixture(
    seed === undefined ? {} : { [TRACK_COLUMNS_KEY]: stored(seed) }
  )
  return { ...fixture, layout: createColumnLayout({ settings: fixture.settings }) }
}

function visibleKeys(layout: ReturnType<typeof createColumnLayout>): TrackColumnKey[] {
  return layout.visibleColumns.value.map((column) => column.key)
}

const DEFAULT_VISIBLE: TrackColumnKey[] = ['trackNo', 'title', 'artist', 'album', 'durationSec']

describe('column catalogue', () => {
  it('offers a sort on exactly the columns main will sort by', () => {
    const sortable = TRACK_COLUMNS.filter((column) => isSortableColumn(column.key)).map(
      (column) => column.key
    )
    expect(new Set(sortable)).toEqual(new Set(TRACK_SORT_COLUMNS))
  })

  it('starts with the five columns W4-1 shipped', () => {
    expect(visibleKeys(columnLayout().layout)).toEqual(DEFAULT_VISIBLE)
  })

  it('gives every column a width no smaller than its minimum', () => {
    for (const column of TRACK_COLUMNS) {
      expect(column.defaultWidth).toBeGreaterThanOrEqual(column.minWidth)
    }
  })
})

describe('normalizeColumnLayout', () => {
  it('is the default set for a profile that has never configured its columns', () => {
    expect(normalizeColumnLayout(null)).toEqual(defaultColumnLayout())
  })

  it('drops keys it does not recognise and duplicates', () => {
    const layout = normalizeColumnLayout(
      stored({
        order: ['title', 'bitrate', 'title', 'artist'],
        hidden: ['album', 'lyrics'],
        widths: { title: 400, mood: 100 }
      })
    )

    expect(layout.order.slice(0, 2)).toEqual(['title', 'artist'])
    expect(layout.order).not.toContain('bitrate')
    expect(layout.order.filter((key) => key === 'title')).toHaveLength(1)
    expect(layout.hidden).toEqual(['album'])
    expect(layout.widths).toEqual({ title: 400 })
  })

  it('appends columns a newer build added rather than losing them', () => {
    // A layout written before `codec` existed.
    const layout = normalizeColumnLayout(stored({ order: ['title', 'artist'] }))
    expect(layout.order).toHaveLength(TRACK_COLUMNS.length)
    expect(layout.order.slice(0, 2)).toEqual(['title', 'artist'])
    expect(layout.order).toContain('codec')
  })

  it('refuses a layout that would hide every column', () => {
    const layout = normalizeColumnLayout(
      stored({ hidden: TRACK_COLUMNS.map((column) => column.key) })
    )
    expect(layout.hidden).toEqual(defaultColumnLayout().hidden)
  })

  it('clamps a stored width to the column minimum', () => {
    const layout = normalizeColumnLayout(stored({ widths: { title: 4, artist: 100_000 } }))
    const title = TRACK_COLUMNS.find((column) => column.key === 'title')!
    expect(layout.widths.title).toBe(title.minWidth)
    expect(layout.widths.artist).toBe(800)
  })

  it('ignores a width for a column it does not have', () => {
    const layout = normalizeColumnLayout(stored({ widths: { mood: 120 } }))
    expect(layout.widths).toEqual({})
  })
})

describe('createColumnLayout', () => {
  it('survives a restart', () => {
    const { storage, settings, layout: first } = columnLayout()

    first.toggleVisible('year')
    first.toggleVisible('album')
    first.setWidth('title', 420)
    first.move('artist', -1)
    settings.flush()
    const expected = visibleKeys(first)

    // A second instance over the same storage is what the next launch gets.
    const second = createColumnLayout({
      settings: createViewSettings({ storage, debounceMs: 0 })
    })
    expect(visibleKeys(second)).toEqual(expected)
    expect(second.widthOf('title')).toBe(420)
    expect(second.isVisible('year')).toBe(true)
    expect(second.isVisible('album')).toBe(false)
  })

  it('works with no storage at all', () => {
    const layout = createColumnLayout({ settings: createViewSettings({ debounceMs: 0 }) })
    layout.toggleVisible('year')
    expect(layout.isVisible('year')).toBe(true)
  })

  it('refuses to hide the last visible column', () => {
    const { layout } = columnLayout()
    for (const key of DEFAULT_VISIBLE.slice(0, 4)) expect(layout.toggleVisible(key)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['durationSec'])

    expect(layout.toggleVisible('durationSec')).toBe(false)
    expect(visibleKeys(layout)).toEqual(['durationSec'])
  })

  it('steps a column past its visible neighbour, not its hidden one', () => {
    const { layout } = columnLayout()

    // `albumArtist` sits between `durationSec` and the rest in the default order
    // but is hidden, so one step must move `durationSec` past `album`.
    expect(layout.move('durationSec', -1)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['trackNo', 'title', 'artist', 'durationSec', 'album'])
  })

  it('will not move a column off either end, or a hidden one at all', () => {
    const { layout } = columnLayout()

    expect(layout.move('trackNo', -1)).toBe(false)
    expect(layout.move('durationSec', 1)).toBe(false)
    expect(layout.move('year', 1)).toBe(false)
    expect(visibleKeys(layout)).toEqual(DEFAULT_VISIBLE)
  })

  it('drops a column before or after the one it was dropped on', () => {
    const { layout } = columnLayout()

    expect(layout.moveBefore('title', 'durationSec', true)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['trackNo', 'artist', 'album', 'durationSec', 'title'])

    expect(layout.moveBefore('title', 'trackNo', false)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['title', 'trackNo', 'artist', 'album', 'durationSec'])

    expect(layout.moveBefore('title', 'title', true)).toBe(false)
  })

  /**
   * A drag used to be held out of storage by a `persist: false` flag. The view
   * store debounces instead, so every caller says the same thing and the
   * coalescing happens once, below — see `tests/renderer/settings/viewStore`.
   */
  it('commits a dragged width on release', () => {
    const { storage, layout } = columnLayout()

    layout.setWidth('title', 300)
    layout.setWidth('title', 340)
    expect(layout.widthOf('title')).toBe(340)

    layout.persist()
    expect(
      createColumnLayout({ settings: createViewSettings({ storage, debounceMs: 0 }) }).widthOf(
        'title'
      )
    ).toBe(340)
  })

  it('reports the total width of the visible columns only', () => {
    const { layout } = columnLayout()
    const expected = DEFAULT_VISIBLE.reduce((sum, key) => sum + layout.widthOf(key), 0)
    expect(layout.totalWidth.value).toBe(expected)

    layout.toggleVisible('title')
    expect(layout.totalWidth.value).toBe(expected - layout.widthOf('title'))
  })

  it('restores the documented default set on reset', () => {
    const { storage, layout } = columnLayout()

    layout.toggleVisible('album')
    layout.toggleVisible('codec')
    layout.setWidth('title', 700)
    layout.move('artist', -1)

    layout.reset()
    expect(visibleKeys(layout)).toEqual(DEFAULT_VISIBLE)
    expect(layout.widthOf('title')).toBe(
      TRACK_COLUMNS.find((column) => column.key === 'title')!.defaultWidth
    )
    // The stored layout is forgotten rather than replaced with today's
    // defaults, so a build that adds a column reaches a table that was reset
    // before it existed — and it is still the default after a restart.
    expect(
      visibleKeys(createColumnLayout({ settings: createViewSettings({ storage, debounceMs: 0 }) }))
    ).toEqual(DEFAULT_VISIBLE)
  })

  it('keeps the sort usable when its column is hidden', () => {
    const { layout } = columnLayout()

    // Hiding the sorted column changes nothing about the layout's knowledge of
    // it — the panel keeps sorting, and the chooser can still name and change it.
    expect(layout.toggleVisible('artist')).toBe(true)
    expect(layout.isVisible('artist')).toBe(false)
    expect(layout.specOf('artist')?.label).toBe('Artist')
    expect(layout.orderedColumns.value.map((column) => column.key)).toContain('artist')

    // And showing it again restores it to the same place in the order.
    expect(layout.toggleVisible('artist')).toBe(true)
    expect(visibleKeys(layout)).toEqual(DEFAULT_VISIBLE)
  })
})
