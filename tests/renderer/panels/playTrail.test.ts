import { describe, expect, it } from 'vitest'
import { buildTrailRows, trailWhen } from '../../../src/renderer/panels/tunedeck/playTrail'
import type { PlayEntry } from '../../../src/shared/history'
import type { Track } from '../../../src/shared/library'

/**
 * What the trail pane draws, tested without Vue.
 *
 * The two claims worth holding to are both here: consecutive replays are one
 * row, and only the head of the trail can be the audible track.
 */

function track(id: number, title = `Track ${id}`): Track {
  return {
    id,
    rootId: 1,
    title,
    artist: 'Ash Anchor',
    album: null,
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    durationSec: 200,
    codec: 'flac',
    encodedBytes: 1000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** Most recent first, as the trail arrives. `id` descends with age. */
function entries(...spec: Array<[trackId: number, playedAt: number]>): PlayEntry[] {
  return spec.map(([trackId, playedAt], index) => ({
    id: 1000 - index,
    playedAt,
    track: track(trackId)
  }))
}

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('trailWhen', () => {
  it('reads "now" under a minute', () => {
    expect(trailWhen(NOW, NOW)).toBe('now')
    expect(trailWhen(NOW - 59_000, NOW)).toBe('now')
  })

  it('counts minutes, then hours, then days', () => {
    expect(trailWhen(NOW - MINUTE, NOW)).toBe('1 min')
    expect(trailWhen(NOW - 59 * MINUTE, NOW)).toBe('59 min')
    expect(trailWhen(NOW - HOUR, NOW)).toBe('1 h')
    expect(trailWhen(NOW - 23 * HOUR, NOW)).toBe('23 h')
    expect(trailWhen(NOW - DAY, NOW)).toBe('1 d')
    expect(trailWhen(NOW - 9 * DAY, NOW)).toBe('9 d')
  })

  it('clamps a play stamped in the future to "now"', () => {
    // A clock correction can leave a stored `playedAt` ahead of the current
    // time. The row's place in the trail comes from its id, so a label reading
    // "in 2 h" would be the one thing in the pane arguing with the order it is
    // drawn in.
    expect(trailWhen(NOW + 2 * HOUR, NOW)).toBe('now')
  })
})

describe('buildTrailRows', () => {
  it('is empty for an empty trail', () => {
    expect(buildTrailRows({ entries: [], nowPlayingId: null, now: NOW })).toEqual([])
  })

  it('keeps distinct plays as distinct rows, newest first', () => {
    const rows = buildTrailRows({
      entries: entries([7, NOW - MINUTE], [8, NOW - 2 * MINUTE], [9, NOW - 3 * MINUTE]),
      nowPlayingId: null,
      now: NOW
    })

    expect(rows.map((row) => row.entry.track.id)).toEqual([7, 8, 9])
    expect(rows.map((row) => row.plays)).toEqual([1, 1, 1])
    expect(rows.map((row) => row.when)).toEqual(['1 min', '2 min', '3 min'])
  })

  it('collapses consecutive plays of one track into a single counted row', () => {
    // What an hour of repeat-one produces: a play per pass, all recorded.
    const rows = buildTrailRows({
      entries: entries([7, NOW - MINUTE], [7, NOW - 5 * MINUTE], [7, NOW - 9 * MINUTE]),
      nowPlayingId: null,
      now: NOW
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.plays).toBe(3)
  })

  it('labels a collapsed run with its newest play', () => {
    const rows = buildTrailRows({
      entries: entries([7, NOW - MINUTE], [7, NOW - 3 * HOUR]),
      nowPlayingId: null,
      now: NOW
    })

    // The run keeps the first entry it saw, which is the newest — that is the
    // id the row is keyed by and the one jump-back replays.
    expect(rows[0]!.when).toBe('1 min')
    expect(rows[0]!.key).toBe('play-1000')
  })

  it('does not collapse a track that was played again later', () => {
    // Played, then two others, then played again. Two separate listens, and the
    // trail says so — collapsing these would make it a play-count table.
    const rows = buildTrailRows({
      entries: entries([7, NOW - MINUTE], [8, NOW - 2 * MINUTE], [7, NOW - 3 * MINUTE]),
      nowPlayingId: null,
      now: NOW
    })

    expect(rows.map((row) => row.entry.track.id)).toEqual([7, 8, 7])
    expect(rows.map((row) => row.plays)).toEqual([1, 1, 1])
  })

  it('marks the head as playing when it is the audible track', () => {
    const rows = buildTrailRows({
      entries: entries([7, NOW], [8, NOW - MINUTE]),
      nowPlayingId: 7,
      now: NOW
    })

    expect(rows[0]!.isPlaying).toBe(true)
    expect(rows[1]!.isPlaying).toBe(false)
  })

  it('marks nothing when the trail head is not what is audible', () => {
    // Playback stopped, or a podcast episode took over: the trail's newest row
    // is a track that finished rather than one that is playing.
    const rows = buildTrailRows({
      entries: entries([7, NOW - 20 * MINUTE], [8, NOW - 25 * MINUTE]),
      nowPlayingId: null,
      now: NOW
    })

    expect(rows.every((row) => !row.isPlaying)).toBe(true)
  })

  it('never marks an older row for a track that is playing again now', () => {
    // Track 7 an hour ago, others since, and 7 playing again — the audible
    // listen has its own row at the top, and marking the old one as well would
    // claim two rows are the same listen.
    const rows = buildTrailRows({
      entries: entries([7, NOW], [8, NOW - 30 * MINUTE], [7, NOW - HOUR]),
      nowPlayingId: 7,
      now: NOW
    })

    expect(rows.map((row) => row.isPlaying)).toEqual([true, false, false])
  })

  it('gives every row a distinct key', () => {
    const rows = buildTrailRows({
      entries: entries([7, NOW], [8, NOW - MINUTE], [7, NOW - 2 * MINUTE]),
      nowPlayingId: null,
      now: NOW
    })

    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })
})
