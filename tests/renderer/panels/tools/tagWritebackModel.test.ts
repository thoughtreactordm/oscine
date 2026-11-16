import { describe, expect, it } from 'vitest'
import type {
  FieldDiff,
  GenreDiff,
  GenreValue,
  PendingWrite,
  WritebackField
} from '../../../../src/shared/tagWriteback'
import { ABSENT_ARTWORK } from '../../../../src/shared/artwork'
import type { TagFieldDef } from '../../../../src/shared/tagFields'
import {
  agentBadgeTitle,
  buildSelections,
  filterByProvenance,
  isAgentRow,
  changedFields,
  fieldLabel,
  fieldText,
  formatArtwork,
  initialSelection,
  isMixedAlbumOverwrite,
  overallState,
  partialAlbumsAfterApply,
  splitAlbums,
  stageNotice,
  rowLabel,
  reviewColumns,
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
    albumArtist: parts.albumArtist ?? unchanged('Album Artist'),
    album: parts.album ?? unchanged('Album'),
    trackNo: parts.trackNo ?? unchanged(1),
    discNo: parts.discNo ?? unchanged(1),
    year: parts.year ?? unchanged(2020),
    genres: parts.genres ?? genres([], [], false),
    artwork: parts.artwork ?? { current: ABSENT_ARTWORK, proposed: ABSENT_ARTWORK, changed: false },
    fields: parts.fields ?? {}
  }
  const hasChanges =
    p.title.changed ||
    p.artist.changed ||
    p.albumArtist.changed ||
    p.album.changed ||
    p.trackNo.changed ||
    p.discNo.changed ||
    p.year.changed ||
    p.genres.changed ||
    p.artwork.changed
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

  it('includes artwork among the changed fields', () => {
    const p = pending(1, {
      artwork: {
        current: ABSENT_ARTWORK,
        proposed: { present: true, hash: 'abc', mime: 'image/png' },
        changed: true
      }
    })
    expect(changedFields(p)).toEqual(['artwork'])
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

describe('formatArtwork / fieldText artwork', () => {
  const cover = { present: true, hash: 'aa', mime: 'image/jpeg' } as const

  it('renders none, a proposed remove, and a mime for a present cover', () => {
    expect(formatArtwork(ABSENT_ARTWORK, 'current', cover)).toBe('—')
    expect(formatArtwork(ABSENT_ARTWORK, 'proposed', cover)).toBe('✕ remove')
    expect(formatArtwork(cover, 'proposed', ABSENT_ARTWORK)).toBe('image/jpeg')
  })

  it('feeds those strings through fieldText', () => {
    const p = pending(1, {
      artwork: { current: cover, proposed: ABSENT_ARTWORK, changed: true }
    })
    expect(fieldText(p, 'artwork')).toEqual({ current: 'image/jpeg', proposed: '✕ remove' })
  })
})

describe('generic fields (W16-18)', () => {
  const withComposers = (): PendingWrite =>
    pending(1, {
      title: changed('Old', 'New'),
      fields: {
        composers: changed<readonly string[] | string | number | boolean>(
          ['Bach'],
          ['Bach', 'Handel']
        ),
        compilation: changed<readonly string[] | string | number | boolean>(null, true),
        bpm: unchanged<readonly string[] | string | number | boolean>(120)
      }
    })

  it('lists changed generic keys after the grouped ones, in registry order', () => {
    expect(changedFields(withComposers())).toEqual(['title', 'composers', 'compilation'])
  })

  it('selects generic fields by default and sends them in canonical order', () => {
    const p = withComposers()
    const selection = initialSelection([p])
    expect(buildSelections([p], selection)).toEqual([
      { trackId: 1, fields: ['title', 'composers', 'compilation'] }
    ])
    selection.get(1)?.delete('composers')
    expect(buildSelections([p], selection)).toEqual([
      { trackId: 1, fields: ['title', 'compilation'] }
    ])
    expect(rowState(p, selection)).toBe('some')
  })

  it('adds a column only for generic fields some track changes', () => {
    const columns = reviewColumns([withComposers(), pending(2)])
    expect(columns.slice(-2)).toEqual(['composers', 'compilation'])
    expect(columns).not.toContain('bpm')
    expect(fieldLabel('composers')).toBe('Composers')
  })

  it('renders list and flag values readably', () => {
    const p = withComposers()
    expect(fieldText(p, 'composers')).toEqual({ current: 'Bach', proposed: 'Bach; Handel' })
    expect(fieldText(p, 'compilation')).toEqual({ current: '—', proposed: 'Yes' })
  })

  it('draws a registry entry it has never seen with no component change', () => {
    // A throwaway entry, not in the shipped registry: the review's columns,
    // labels, cells and selection all come from the registry argument.
    const mood: TagFieldDef = {
      key: 'mood',
      label: 'Mood',
      group: 'content',
      taglib: 'mood',
      kind: 'list',
      readOnly: false,
      admitted: true
    }
    const registry = [mood]
    const p = pending(3, {
      fields: {
        mood: changed(['calm'], ['calm', 'bright'])
      } as unknown as PendingWrite['fields']
    })
    const column = 'mood' as WritebackField
    expect(reviewColumns([p], registry)).toContain(column)
    expect(fieldLabel(column, registry)).toBe('Mood')
    expect(fieldText(p, column, registry)).toEqual({ current: 'calm', proposed: 'calm; bright' })
    expect(buildSelections([p], initialSelection([p], registry), registry)).toEqual([
      { trackId: 3, fields: [column] }
    ])
  })
})

describe('agent provenance (W24-8)', () => {
  const operator = pending(1, { albumArtist: changed('A', 'B') })
  const agent: PendingWrite = {
    ...pending(2, { albumArtist: changed('A', 'B'), year: changed(2019, 2020) }),
    agent: { fields: ['albumArtist', 'conductor'], changesetIds: [4, 7] }
  }
  const emptied: PendingWrite = {
    ...pending(3, { title: changed('x', 'y') }),
    agent: { fields: [], changesetIds: [] }
  }

  it('marks only rows an agent staged a field on', () => {
    expect([operator, agent, emptied].map(isAgentRow)).toEqual([false, true, false])
  })

  it('filters to agent rows in order, and "all" keeps every row', () => {
    const rows = [operator, agent, emptied]
    expect(filterByProvenance(rows, 'agent').map((row) => row.trackId)).toEqual([2])
    expect(filterByProvenance(rows, 'all').map((row) => row.trackId)).toEqual([1, 2, 3])
  })

  it('names the fields and changesets in the badge tooltip', () => {
    expect(agentBadgeTitle(agent)).toBe(
      'Staged by an agent (changesets #4, #7): Album artist, Conductor'
    )
    expect(agentBadgeTitle(operator)).toBe('')
  })
})

/**
 * W25-6 — the ReplayGain half of the review (oscine-replaygain D37): Decision D
 * rows start unchecked, and R21 warns when a selection or a flush leaves an
 * album with mixed album gains.
 */
describe('ReplayGain review (W25-6)', () => {
  /** A row staging an album gain (and peak), optionally a track gain too. */
  function rgRow(
    trackId: number,
    opts: {
      albumId?: number
      album?: string
      fileAlbumGain?: number | null
      albumGain?: number
      trackGain?: boolean
    } = {}
  ): PendingWrite {
    const base = pending(trackId, {
      album: unchanged(opts.album ?? 'Album'),
      fields: {
        replayGainAlbumGain: changed<number>(opts.fileAlbumGain ?? null, opts.albumGain ?? -7.5),
        replayGainAlbumPeak: changed<number>(null, 0.98),
        ...(opts.trackGain ? { replayGainTrackGain: changed<number>(null, -6.2) } : {})
      }
    })
    return {
      ...base,
      hasChanges: true,
      ...(opts.albumId === undefined ? {} : { replayGain: { albumId: opts.albumId } })
    }
  }

  describe('Decision D: differing album gains start deselected', () => {
    it('leaves a file album gain more than 0.1 dB away unchecked', () => {
      const row = rgRow(1, { fileAlbumGain: -6.0, albumGain: -7.5 })
      expect(isMixedAlbumOverwrite(row)).toBe(true)
      const selection = initialSelection([row])
      expect([...selection.get(1)!]).toEqual([])
      expect(rowState(row, selection)).toBe('none')
      expect(buildSelections([row], selection)).toEqual([])
    })

    it('keeps the rest of the row checked', () => {
      const row = rgRow(1, { fileAlbumGain: -6.0, trackGain: true })
      expect([...initialSelection([row]).get(1)!]).toEqual(['replayGainTrackGain'])
    })

    it('checks a gap fill (the file has no album gain)', () => {
      const row = rgRow(1, { fileAlbumGain: null })
      expect(isMixedAlbumOverwrite(row)).toBe(false)
      expect([...initialSelection([row]).get(1)!].sort()).toEqual([
        'replayGainAlbumGain',
        'replayGainAlbumPeak'
      ])
    })

    it('treats exactly 0.1 dB as within the margin', () => {
      expect(isMixedAlbumOverwrite(rgRow(1, { fileAlbumGain: -7.4, albumGain: -7.5 }))).toBe(false)
    })

    it('ignores rows that do not touch the album gain', () => {
      expect(isMixedAlbumOverwrite(pending(1, { title: changed('a', 'b') }))).toBe(false)
    })
  })

  describe('split-album warning (R21)', () => {
    const rows = [
      rgRow(1, { albumId: 10, album: 'Kid A', trackGain: true }),
      rgRow(2, { albumId: 10, album: 'Kid A', trackGain: true }),
      rgRow(3, { albumId: 10, album: 'Kid A', fileAlbumGain: -5.0 }),
      rgRow(4, { albumId: 20, album: 'Amnesiac', trackGain: true }),
      rgRow(5, { albumId: 20, album: 'Amnesiac', trackGain: true })
    ]

    it('warns about the album a Decision D row splits by default', () => {
      expect(splitAlbums(rows, initialSelection(rows))).toEqual([
        { albumId: 10, title: 'Kid A', total: 3, landing: 2 }
      ])
    })

    it('clears once the Decision D row is opted in', () => {
      const selection = initialSelection(rows)
      selection.get(3)!.add('replayGainAlbumGain')
      expect(splitAlbums(rows, selection)).toEqual([])
    })

    it('warns when the operator deselects one row of an album', () => {
      const selection = initialSelection(rows)
      selection.get(3)!.add('replayGainAlbumGain')
      selection.get(5)!.delete('replayGainAlbumGain')
      expect(splitAlbums(rows, selection).map((album) => album.albumId)).toEqual([20])
    })

    it('does not warn when a whole album is left out', () => {
      const selection = initialSelection(rows)
      for (const id of [1, 2]) selection.get(id)!.clear()
      expect(splitAlbums(rows, selection)).toEqual([])
    })

    it('does not warn for a track gain deselected on its own', () => {
      const selection = initialSelection(rows)
      selection.get(3)!.add('replayGainAlbumGain')
      selection.get(4)!.delete('replayGainTrackGain')
      expect(splitAlbums(rows, selection)).toEqual([])
    })

    it('ignores rows with no album (singles)', () => {
      const singles = [rgRow(1, { trackGain: true }), rgRow(2, { fileAlbumGain: -3 })]
      expect(splitAlbums(singles, initialSelection(singles))).toEqual([])
    })
  })

  describe('albums left partial after apply (R21)', () => {
    const rows = [
      rgRow(1, { albumId: 10, album: 'Kid A' }),
      rgRow(2, { albumId: 10, album: 'Kid A' }),
      rgRow(3, { albumId: 20, album: 'Amnesiac' }),
      rgRow(4, { albumId: 20, album: 'Amnesiac' })
    ]

    it('lists an album where one file failed', () => {
      const partial = partialAlbumsAfterApply(rows, initialSelection(rows), [
        { trackId: 1, status: 'written' },
        { trackId: 2, status: 'failed', code: 'write-failed' },
        { trackId: 3, status: 'written' },
        { trackId: 4, status: 'skipped' }
      ])
      expect(partial).toEqual([{ albumId: 10, title: 'Kid A', total: 2, landing: 1 }])
    })

    it('counts a file a cancelled flush never reached as left behind', () => {
      const partial = partialAlbumsAfterApply(rows, initialSelection(rows), [
        { trackId: 1, status: 'written' },
        { trackId: 2, status: 'written' },
        { trackId: 3, status: 'written' }
      ])
      expect(partial.map((album) => album.albumId)).toEqual([20])
    })

    it('counts a deselected row as left behind', () => {
      const selection = initialSelection(rows)
      selection.get(4)!.clear()
      const partial = partialAlbumsAfterApply(rows, selection, [
        { trackId: 1, status: 'written' },
        { trackId: 2, status: 'written' },
        { trackId: 3, status: 'written' }
      ])
      expect(partial.map((album) => album.albumId)).toEqual([20])
    })

    it('is empty when every album lands whole', () => {
      const outcomes = rows.map((row) => ({ trackId: row.trackId, status: 'written' as const }))
      expect(partialAlbumsAfterApply(rows, initialSelection(rows), outcomes)).toEqual([])
    })
  })

  describe('stageNotice', () => {
    it('summarises what was staged and groups skips by reason', () => {
      expect(
        stageNotice({
          stagedTracks: 12,
          stagedAlbums: 1,
          skipped: [
            { albumId: 1, reason: 'unmeasured' },
            { albumId: 2, reason: 'unmeasured' },
            { albumId: 3, reason: 'failed' }
          ]
        })
      ).toBe(
        'Staged 12 tracks across 1 album · 2 albums skipped: not fully measured yet · 1 album skipped: a track failed to measure'
      )
    })

    it('says when there was nothing to stage', () => {
      expect(stageNotice({ stagedTracks: 0, stagedAlbums: 0, skipped: [] })).toBe(
        'Nothing measured to stage'
      )
    })

    it('omits the album clause for singles only', () => {
      expect(stageNotice({ stagedTracks: 1, stagedAlbums: 0, skipped: [] })).toBe('Staged 1 track')
    })
  })
})
