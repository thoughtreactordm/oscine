import { describe, expect, it } from 'vitest'
import type {
  FieldDiff,
  GenreDiff,
  GenreValue,
  PendingWrite,
  WritebackField
} from '../../../../src/shared/tagWriteback'
import {
  buildSelections,
  changedFields,
  initialSelection,
  overallState,
  rowLabel,
  rowState,
  selectionSummary,
  type SelectionMap
} from '../../../../src/renderer/panels/tools/tagWritebackModel'

/**
 * The staged review's selection model — W16-6, the pure half. No Pinia, no DOM:
 * just the arithmetic that turns a set of diffs and a set of checkboxes into the
 * batch main flushes and the summaries the header reads.
 */

function unchanged<T>(value: T | null): FieldDiff<T> {
  return { current: value, proposed: value, changed: false }
}

function changed<T>(current: T | null, proposed: T | null): FieldDiff<T> {
  return { current, proposed, changed: true }
}

function genres(
  current: readonly GenreValue[],
  proposed: readonly GenreValue[],
  isChanged: boolean
): GenreDiff {
  return { current, proposed, changed: isChanged }
}

function pending(
  trackId: number,
  parts: Partial<Omit<PendingWrite, 'trackId' | 'hasChanges'>> = {}
): PendingWrite {
  const p = {
    title: parts.title ?? unchanged('Title'),
    artist: parts.artist ?? unchanged('Artist'),
    album: parts.album ?? unchanged('Album'),
    trackNo: parts.trackNo ?? unchanged(1),
    discNo: parts.discNo ?? unchanged(1),
    year: parts.year ?? unchanged(2020),
    genres: parts.genres ?? genres([], [], false)
  }
  const hasChanges =
    p.title.changed ||
    p.artist.changed ||
    p.album.changed ||
    p.trackNo.changed ||
    p.discNo.changed ||
    p.year.changed ||
    p.genres.changed
  return { trackId, ...p, hasChanges }
}

describe('changedFields', () => {
  it('lists a track’s changed fields in canonical order', () => {
    const p = pending(1, {
      year: changed(2019, 2020),
      title: changed('a', 'b'),
      genres: genres([], [{ key: 'x', label: 'X' }], true)
    })
    expect(changedFields(p)).toEqual(['title', 'year', 'genres'])
  })
})

describe('initialSelection', () => {
  it('selects every changed field of every track by default', () => {
    const p1 = pending(1, { title: changed('a', 'b') })
    const p2 = pending(2, { year: changed(1, 2), album: changed('x', 'y') })
    const selection = initialSelection([p1, p2])
    expect([...(selection.get(1) ?? [])]).toEqual(['title'])
    expect([...(selection.get(2) ?? [])].sort()).toEqual(['album', 'year'])
  })
})

describe('buildSelections', () => {
  it('drops tracks with no selected fields and orders the fields canonically', () => {
    const p1 = pending(1, { title: changed('a', 'b'), year: changed(1, 2) })
    const p2 = pending(2, { album: changed('x', 'y') })
    const selection: SelectionMap = new Map([
      [1, new Set<WritebackField>(['year', 'title'])],
      [2, new Set<WritebackField>()]
    ])
    expect(buildSelections([p1, p2], selection)).toEqual([
      { trackId: 1, fields: ['title', 'year'] }
    ])
  })
})

describe('selectionSummary', () => {
  it('counts tracks with a selection and the fields across them', () => {
    const p1 = pending(1, { title: changed('a', 'b'), year: changed(1, 2) })
    const p2 = pending(2, { album: changed('x', 'y') })
    const selection: SelectionMap = new Map([
      [1, new Set<WritebackField>(['title', 'year'])],
      [2, new Set<WritebackField>()]
    ])
    expect(selectionSummary([p1, p2], selection)).toEqual({ tracks: 1, fields: 2 })
  })
})

describe('rowState / overallState', () => {
  const p = pending(1, { title: changed('a', 'b'), year: changed(1, 2) })

  it('is all/some/none over a row’s changed fields', () => {
    expect(rowState(p, new Map([[1, new Set<WritebackField>(['title', 'year'])]]))).toBe('all')
    expect(rowState(p, new Map([[1, new Set<WritebackField>(['title'])]]))).toBe('some')
    expect(rowState(p, new Map([[1, new Set<WritebackField>()]]))).toBe('none')
  })

  it('summarises the whole batch for the header control', () => {
    const q = pending(2, { album: changed('x', 'y') })
    const allOn: SelectionMap = new Map([
      [1, new Set<WritebackField>(['title', 'year'])],
      [2, new Set<WritebackField>(['album'])]
    ])
    const mixed: SelectionMap = new Map([
      [1, new Set<WritebackField>(['title', 'year'])],
      [2, new Set<WritebackField>()]
    ])
    expect(overallState([p, q], allOn)).toBe('all')
    expect(overallState([p, q], mixed)).toBe('some')
    expect(
      overallState(
        [p, q],
        new Map([
          [1, new Set<WritebackField>()],
          [2, new Set<WritebackField>()]
        ])
      )
    ).toBe('none')
  })
})

describe('rowLabel', () => {
  it('identifies the track from the diff, preferring current over proposed', () => {
    const p = pending(1, { title: changed('Old', 'New'), artist: unchanged('The Band') })
    expect(rowLabel(p)).toEqual({ primary: 'Old', secondary: 'The Band' })
  })

  it('falls back to the track id when there is no title at all', () => {
    const p = pending(7, { title: unchanged<string>(null), artist: unchanged<string>(null) })
    expect(rowLabel(p)).toEqual({ primary: 'Track 7', secondary: '' })
  })
})
