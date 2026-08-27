import { describe, expect, it } from 'vitest'
import {
  rankedCaption,
  rankedRows,
  revealTextFor
} from '../../../src/renderer/panels/listening/listeningRows'
import { MAX_SEARCH_LENGTH } from '@shared/library'
import type { StatsQueryResult, StatsRow } from '@shared/stats'

function row(over: Partial<StatsRow> = {}): StatsRow {
  return {
    key: 'k',
    label: 'Tomorrow Never Knows',
    sublabel: 'The Beatles',
    listens: 10,
    msListened: 600_000,
    trackId: 7,
    artworkHash: null,
    ...over
  }
}

function result(rows: StatsRow[], total = rows.length): StatsQueryResult {
  return { dimension: 'track', sort: 'listens', rows, total }
}

describe('revealTextFor', () => {
  it('sends the row and what is under it, so the terms AND together', () => {
    expect(revealTextFor('track', row())).toBe('Tomorrow Never Knows The Beatles')
    expect(revealTextFor('album', row({ label: 'Revolver', sublabel: 'The Beatles' }))).toBe(
      'Revolver The Beatles'
    )
  })

  it('sends an artist row alone, because it has nothing under it', () => {
    expect(revealTextFor('artist', row({ label: 'Talk Talk', sublabel: null }))).toBe('Talk Talk')
  })

  it('never clicks a genre through, because the library has no genre predicate', () => {
    expect(revealTextFor('genre', row({ label: 'post-punk', sublabel: null }))).toBeNull()
  })

  it('drops the sublabel before it drops the row', () => {
    const label = 'A'.repeat(MAX_SEARCH_LENGTH - 2)
    expect(revealTextFor('track', row({ label, sublabel: 'The Beatles' }))).toBe(label)
  })

  it('does not click through what cannot be sent at all', () => {
    expect(revealTextFor('track', row({ label: 'A'.repeat(MAX_SEARCH_LENGTH + 1) }))).toBeNull()
  })

  it('does not click through what would compile to an empty match', () => {
    // Every term below the trigram floor, so the FTS builder has nothing to
    // search for and the library would come back empty for no visible reason.
    expect(revealTextFor('track', row({ label: 'Go', sublabel: 'U2' }))).toBeNull()
    expect(revealTextFor('artist', row({ label: 'M', sublabel: null }))).toBeNull()
    // One long enough term is all it takes.
    expect(revealTextFor('artist', row({ label: 'Yes', sublabel: null }))).toBe('Yes')
  })
})

describe('rankedRows', () => {
  it('carries both totals whichever one the list is ordered by', () => {
    const rows = rankedRows(result([row()]), 'time', 'track')
    expect(rows[0].plays).toBe('10 plays')
    expect(rows[0].time).toBe('10m')
  })

  it('numbers rows from one, in the order main ranked them', () => {
    const rows = rankedRows(
      result([row({ key: 'a' }), row({ key: 'b' }), row({ key: 'c' })]),
      'listens',
      'track'
    )
    expect(rows.map((entry) => entry.rank)).toEqual([1, 2, 3])
    expect(rows.map((entry) => entry.key)).toEqual(['a', 'b', 'c'])
  })

  it('measures the bar against the leader, in the total being sorted by', () => {
    const rows = rankedRows(
      result([
        row({ key: 'a', listens: 100, msListened: 1_000 }),
        row({ key: 'b', listens: 25, msListened: 900 })
      ]),
      'listens',
      'track'
    )
    expect(rows[0].share).toBe(1)
    expect(rows[1].share).toBe(0.25)

    const byTime = rankedRows(
      result([
        row({ key: 'a', listens: 100, msListened: 1_000 }),
        row({ key: 'b', listens: 25, msListened: 900 })
      ]),
      'time',
      'track'
    )
    expect(byTime[1].share).toBe(0.9)
  })

  it('draws no bar rather than dividing by zero', () => {
    const rows = rankedRows(result([row({ listens: 0, msListened: 0 })]), 'listens', 'track')
    expect(rows[0].share).toBe(0)
  })

  it('is empty before an answer arrives', () => {
    expect(rankedRows(null, 'listens', 'track')).toEqual([])
  })
})

describe('rankedCaption', () => {
  it('says how much was left out', () => {
    expect(rankedCaption(result([row()], 431), 'artist')).toBe('Top 1 of 431 artists')
  })

  it('says nothing when the list is showing everything there is', () => {
    expect(rankedCaption(result([row()], 1), 'artist')).toBeNull()
    expect(rankedCaption(result([], 0), 'artist')).toBeNull()
    expect(rankedCaption(null, 'artist')).toBeNull()
  })
})
