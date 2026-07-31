import { describe, expect, it } from 'vitest'
import type { PlaybackStatus } from '../../../src/renderer/audio/AudioEngine'
import {
  nowPlayingIcon,
  nowPlayingLabel,
  nowPlayingMark
} from '../../../src/renderer/panels/nowPlayingMark'

/**
 * The one rule the song lists share.
 *
 * Worth its own module and its own test because the mark is drawn per cell, in a
 * virtualized table, from a page that may not have arrived — three chances to
 * turn "which song is playing" into a different answer per pane. The component
 * supplies the row and the transport; everything that decides is here.
 */

const mark = (
  trackId: number | undefined,
  playingTrackId: number | null,
  status: PlaybackStatus
): ReturnType<typeof nowPlayingMark> => nowPlayingMark({ trackId, playingTrackId, status })

describe('nowPlayingMark', () => {
  it('marks the row whose track is loaded in the transport', () => {
    expect(mark(7, 7, 'playing')).toBe('playing')
  })

  it('distinguishes paused from playing, because a paused row is still the place', () => {
    expect(mark(7, 7, 'paused')).toBe('paused')
  })

  it('treats a loaded-but-not-yet-audible track as paused', () => {
    // The gap between the click and the first sample is exactly when the
    // operator is looking for the row they just started.
    expect(mark(7, 7, 'loading')).toBe('paused')
    expect(mark(7, 7, 'ready')).toBe('paused')
  })

  it('marks nothing when the transport is pointed at nothing', () => {
    expect(mark(7, 7, 'idle')).toBeNull()
    expect(mark(7, 7, 'ended')).toBeNull()
    expect(mark(7, null, 'playing')).toBeNull()
  })

  it('marks nothing for a row whose page has not arrived', () => {
    // Scrolling a 100k list outruns its pages; an unloaded row is not a claim
    // that the song is elsewhere, so it makes no claim at all.
    expect(mark(undefined, 7, 'playing')).toBeNull()
  })

  it('marks every row holding the playing track, wherever it is showing', () => {
    // The same song in the library list and twice in a playlist is three rows
    // and one track id. All three are true statements about what is playing.
    const rows = [7, 12, 7, 7]
    expect(rows.map((id) => mark(id, 7, 'playing'))).toEqual([
      'playing',
      null,
      'playing',
      'playing'
    ])
  })

  it('marks no row that merely sits next to the playing one', () => {
    expect(mark(8, 7, 'playing')).toBeNull()
  })
})

describe('the mark vocabulary', () => {
  it('gives each mark a filled glyph and a spoken label', () => {
    expect(nowPlayingIcon('playing')).toBe('i-tabler-player-play-filled')
    expect(nowPlayingIcon('paused')).toBe('i-tabler-player-pause-filled')
    expect(nowPlayingLabel('playing')).toBe('(playing)')
    expect(nowPlayingLabel('paused')).toBe('(paused)')
  })

  it('is total, so a template that asks before it guards renders nothing', () => {
    expect(nowPlayingIcon(null)).toBe('')
    expect(nowPlayingLabel(null)).toBe('')
  })
})
