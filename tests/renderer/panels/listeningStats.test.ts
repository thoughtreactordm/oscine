import { describe, expect, it } from 'vitest'
import { ALL_TIME, type StatsScopeBy, type StatsSummary } from '../../../src/shared/stats'
import {
  countListening,
  listeningRows,
  listeningState,
  type ListeningView
} from '../../../src/renderer/panels/tunedeck/listeningStats'

/**
 * The deck's Listening groups, minus their rendering (W10-11, D17).
 *
 * The branch order, the badge and the wording, which are the three things in
 * this pane that can be wrong without looking wrong. All three live outside the
 * `.vue` file precisely so they can be asked about here — `favoriteSongs.test.ts`
 * is the precedent, and the reason is the same: Vitest runs with no Vue plugin.
 */

function summary(by: StatsScopeBy, over: Partial<StatsSummary> = {}): StatsSummary {
  return {
    range: ALL_TIME,
    scope: { trackId: 1, by },
    resolved: true,
    listens: 0,
    msListened: 0,
    tracks: 0,
    artists: 0,
    albums: 0,
    firstListenAt: null,
    lastListenAt: null,
    ...over
  }
}

const VIEW: ListeningView = { seedId: 1, loading: false, failed: false, answered: true }

describe('listeningState', () => {
  it('stands down before anything else, with nothing playing', () => {
    // Outranks a failure and a load in flight: a deck with no track is not
    // describing anything, so it has no counts to be zero or to be wrong.
    expect(listeningState({ seedId: null, loading: true, failed: true, answered: false })).toBe(
      'standby'
    )
  })

  it('reports a failure over a load, so the retry does not hide its own button', () => {
    expect(listeningState({ ...VIEW, failed: true, loading: true })).toBe('failed')
  })

  it('is loading until an answer has arrived for the seed', () => {
    expect(listeningState({ ...VIEW, loading: true })).toBe('loading')
    // Not loading and not answered — the tick between a seed being set and the
    // three queries being issued. Without this the group flashes its rows empty.
    expect(listeningState({ ...VIEW, answered: false })).toBe('loading')
  })

  /**
   * The card's own instruction, held as a test: a zero is a real answer. There
   * is no empty state to fall into, so a freshly scanned track cannot make this
   * group disappear.
   */
  it('draws rows for a track nobody has played', () => {
    expect(listeningState(VIEW)).toBe('rows')
    const [row] = listeningRows(['track'], { track: summary('track') })
    expect(row?.total).toBe('0 plays · 0m')
    expect(row?.absent).toBeNull()
  })
})

describe('listeningRows', () => {
  it('draws one row per scope, in the order asked for', () => {
    const rows = listeningRows(['track', 'album'], {
      track: summary('track', { listens: 42, msListened: 8_280_000 }),
      album: summary('album', { listens: 310, msListened: 65_040_000 })
    })

    expect(rows.map((row) => row.scope)).toEqual(['track', 'album'])
    expect(rows.map((row) => row.label)).toEqual(['This track', 'This album'])
    expect(rows[0]?.total).toBe('42 plays · 2h 18m')
    expect(rows[1]?.total).toBe('310 plays · 18h 4m')
  })

  it('reports the span only when there is one', () => {
    const rows = listeningRows(['track', 'album'], {
      track: summary('track', { listens: 2, firstListenAt: 100, lastListenAt: 900 }),
      album: summary('album')
    })

    expect(rows[0]?.span).toEqual({ first: 100, last: 900 })
    // Never played: no dates to report, and a blank date line under "0 plays"
    // is a row with a hole in it rather than a row with less to say.
    expect(rows[1]?.span).toBeNull()
  })

  /**
   * "Nothing to ask about" and "not played yet" are two different sentences,
   * and this is the branch that keeps them apart. An unresolved scope says why
   * rather than reporting a zero it did not measure.
   */
  it('says why a scope has no group instead of reporting zero', () => {
    const rows = listeningRows(['album', 'artist'], {
      album: summary('album', { resolved: false }),
      artist: summary('artist', { resolved: false })
    })

    expect(rows.map((row) => row.total)).toEqual([null, null])
    expect(rows[0]?.absent).toBe('This track names no album.')
    expect(rows[1]?.absent).toBe('This track names no artist.')
  })

  it('skips a scope it has no answer for rather than inventing a state', () => {
    expect(listeningRows(['track', 'album'], { track: summary('track') })).toHaveLength(1)
    expect(listeningRows(['artist'], {})).toEqual([])
  })
})

describe('countListening', () => {
  it('badges the scope the tab is about, and never a sum of overlapping ones', () => {
    const summaries = {
      track: summary('track', { listens: 42 }),
      album: summary('album', { listens: 310 }),
      artist: summary('artist', { listens: 1204 })
    }

    expect(countListening('track', summaries)).toBe((42).toLocaleString())
    expect(countListening('artist', summaries)).toBe((1204).toLocaleString())
  })

  /**
   * `null` rather than `'0'` before an answer, following `countArtistFavorites`.
   * A badge exists to say whether the group is worth opening, and a zero that
   * becomes 1,204 a moment later has already answered that question wrong.
   */
  it('says nothing until it has something to say', () => {
    expect(countListening('artist', null)).toBeNull()
    expect(countListening('artist', {})).toBeNull()
    expect(countListening('album', { album: summary('album', { resolved: false }) })).toBeNull()
    // Zero *is* a number here, unlike the badge on a list: the group has an
    // answer and the answer is none, which is exactly what the operator opened
    // a play count to find out.
    expect(countListening('track', { track: summary('track') })).toBe('0')
  })
})
