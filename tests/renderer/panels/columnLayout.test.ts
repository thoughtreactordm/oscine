import { describe, expect, it } from 'vitest'
import {
  createColumnLayout,
  defaultColumnLayout,
  isSortableColumn,
  normalizeColumnLayout,
  TRACK_COLUMNS,
  type LayoutStorage,
  type TrackColumnKey
} from '../../../src/renderer/panels/columnLayout'
import { TRACK_SORT_COLUMNS } from '../../../src/shared/library'

/**
 * The column layout, which is the one piece of panel state that has to survive
 * the process.
 *
 * The interesting cases are all about coming *back*: what a stale, truncated or
 * hand-edited blob does to a table that has no other way to get its columns
 * back. So the storage here is a plain object, and several tests deliberately
 * feed it nonsense.
 */
function fakeStorage(initial: string | null = null): LayoutStorage & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value
    },
    write(next: string) {
      this.value = next
    }
  }
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
    const layout = createColumnLayout()
    expect(visibleKeys(layout)).toEqual(DEFAULT_VISIBLE)
  })

  it('gives every column a width no smaller than its minimum', () => {
    for (const column of TRACK_COLUMNS) {
      expect(column.defaultWidth).toBeGreaterThanOrEqual(column.minWidth)
    }
  })
})

describe('normalizeColumnLayout', () => {
  it('falls back to the defaults for anything that is not a layout', () => {
    for (const raw of [null, undefined, 42, 'columns', [], { order: 'title' }]) {
      expect(normalizeColumnLayout(raw)).toEqual(defaultColumnLayout())
    }
  })

  it('drops keys it does not recognise and duplicates', () => {
    const layout = normalizeColumnLayout({
      order: ['title', 'bitrate', 'title', 'artist'],
      hidden: ['album', 'lyrics'],
      widths: { title: 400, mood: 100 }
    })

    expect(layout.order.slice(0, 2)).toEqual(['title', 'artist'])
    expect(layout.order).not.toContain('bitrate')
    expect(layout.order.filter((key) => key === 'title')).toHaveLength(1)
    expect(layout.hidden).toEqual(['album'])
    expect(layout.widths).toEqual({ title: 400 })
  })

  it('appends columns a newer build added rather than losing them', () => {
    // A layout written before `codec` existed.
    const layout = normalizeColumnLayout({ order: ['title', 'artist'] })
    expect(layout.order).toHaveLength(TRACK_COLUMNS.length)
    expect(layout.order.slice(0, 2)).toEqual(['title', 'artist'])
    expect(layout.order).toContain('codec')
  })

  it('refuses a layout that would hide every column', () => {
    const layout = normalizeColumnLayout({
      hidden: TRACK_COLUMNS.map((column) => column.key)
    })
    expect(layout.hidden).toEqual(defaultColumnLayout().hidden)
  })

  it('clamps a stored width to the column minimum', () => {
    const layout = normalizeColumnLayout({ widths: { title: 4, artist: 100_000 } })
    const title = TRACK_COLUMNS.find((column) => column.key === 'title')!
    expect(layout.widths.title).toBe(title.minWidth)
    expect(layout.widths.artist).toBe(800)
  })

  it('ignores a width that is not a finite number', () => {
    const layout = normalizeColumnLayout({ widths: { title: 'wide', artist: null } })
    expect(layout.widths).toEqual({})
  })
})

describe('createColumnLayout', () => {
  it('survives a restart', () => {
    const storage = fakeStorage()
    const first = createColumnLayout({ storage })

    first.toggleVisible('year')
    first.toggleVisible('album')
    first.setWidth('title', 420)
    first.move('artist', -1)
    const expected = visibleKeys(first)

    // A second instance is what the next launch of the app gets.
    const second = createColumnLayout({ storage })
    expect(visibleKeys(second)).toEqual(expected)
    expect(second.widthOf('title')).toBe(420)
    expect(second.isVisible('year')).toBe(true)
    expect(second.isVisible('album')).toBe(false)
  })

  it('starts from the defaults when storage holds something unparseable', () => {
    const layout = createColumnLayout({ storage: fakeStorage('{not json') })
    expect(visibleKeys(layout)).toEqual(DEFAULT_VISIBLE)
  })

  it('works with no storage at all', () => {
    const layout = createColumnLayout()
    layout.toggleVisible('year')
    expect(layout.isVisible('year')).toBe(true)
  })

  it('refuses to hide the last visible column', () => {
    const layout = createColumnLayout({ storage: fakeStorage() })
    for (const key of DEFAULT_VISIBLE.slice(0, 4)) expect(layout.toggleVisible(key)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['durationSec'])

    expect(layout.toggleVisible('durationSec')).toBe(false)
    expect(visibleKeys(layout)).toEqual(['durationSec'])
  })

  it('steps a column past its visible neighbour, not its hidden one', () => {
    const storage = fakeStorage()
    const layout = createColumnLayout({ storage })

    // `albumArtist` sits between `durationSec` and the rest in the default order
    // but is hidden, so one step must move `durationSec` past `album`.
    expect(layout.move('durationSec', -1)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['trackNo', 'title', 'artist', 'durationSec', 'album'])
  })

  it('will not move a column off either end, or a hidden one at all', () => {
    const layout = createColumnLayout({ storage: fakeStorage() })

    expect(layout.move('trackNo', -1)).toBe(false)
    expect(layout.move('durationSec', 1)).toBe(false)
    expect(layout.move('year', 1)).toBe(false)
    expect(visibleKeys(layout)).toEqual(DEFAULT_VISIBLE)
  })

  it('drops a column before or after the one it was dropped on', () => {
    const layout = createColumnLayout({ storage: fakeStorage() })

    expect(layout.moveBefore('title', 'durationSec', true)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['trackNo', 'artist', 'album', 'durationSec', 'title'])

    expect(layout.moveBefore('title', 'trackNo', false)).toBe(true)
    expect(visibleKeys(layout)).toEqual(['title', 'trackNo', 'artist', 'album', 'durationSec'])

    expect(layout.moveBefore('title', 'title', true)).toBe(false)
  })

  it('holds a width steady while a drag is in progress, then commits it', () => {
    const storage = fakeStorage()
    const layout = createColumnLayout({ storage })

    layout.setWidth('title', 300, { persist: false })
    layout.setWidth('title', 340, { persist: false })
    expect(layout.widthOf('title')).toBe(340)
    // Nothing written yet: a drag is not a decision until the pointer is released.
    expect(storage.value).toBeNull()

    layout.persist()
    expect(createColumnLayout({ storage }).widthOf('title')).toBe(340)
  })

  it('reports the total width of the visible columns only', () => {
    const layout = createColumnLayout({ storage: fakeStorage() })
    const expected = DEFAULT_VISIBLE.reduce((sum, key) => sum + layout.widthOf(key), 0)
    expect(layout.totalWidth.value).toBe(expected)

    layout.toggleVisible('title')
    expect(layout.totalWidth.value).toBe(expected - layout.widthOf('title'))
  })

  it('restores the documented default set on reset', () => {
    const storage = fakeStorage()
    const layout = createColumnLayout({ storage })

    layout.toggleVisible('album')
    layout.toggleVisible('codec')
    layout.setWidth('title', 700)
    layout.move('artist', -1)

    layout.reset()
    expect(visibleKeys(layout)).toEqual(DEFAULT_VISIBLE)
    expect(layout.widthOf('title')).toBe(
      TRACK_COLUMNS.find((column) => column.key === 'title')!.defaultWidth
    )
    // The reset is persisted, so it is still the default after a restart.
    expect(visibleKeys(createColumnLayout({ storage }))).toEqual(DEFAULT_VISIBLE)
  })

  it('keeps the sort usable when its column is hidden', () => {
    const layout = createColumnLayout({ storage: fakeStorage() })

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
