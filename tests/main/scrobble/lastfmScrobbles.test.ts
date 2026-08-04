/**
 * The batch that goes out and the document that comes back — W11-4's two
 * genuinely fiddly surfaces, tested without a socket or a credential.
 *
 * Both directions are pure functions on purpose. The alternative is discovering
 * an off-by-one in the array indices or a mis-read `ignoredMessage` against the
 * live API, where a wrong answer costs a real scrobble on a real account and the
 * feedback loop is a browser refresh.
 */

import { describe, expect, it } from 'vitest'
import type { ScrobblePayload, ScrobbleSubmission } from '../../../src/shared/scrobble'
import {
  LASTFM_IGNORED,
  loveParams,
  nowPlayingParams,
  readScrobbleResponse,
  scrobbleBatchParams
} from '../../../src/main/scrobble/lastfm/scrobbles'
import { signatureBase } from '../../../src/main/scrobble/lastfm/signature'

const payload = (overrides: Partial<ScrobblePayload> = {}): ScrobblePayload => ({
  artistName: 'Talk Talk',
  title: 'Ascension Day',
  albumTitle: 'Laughing Stock',
  albumArtistName: null,
  durationSeconds: 366,
  timestamp: 1_754_000_000,
  ...overrides
})

const batchOf = (count: number): ScrobbleSubmission[] =>
  Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    payload: payload({ title: `Track ${index}`, timestamp: 1_754_000_000 + index * 400 })
  }))

describe('scrobbleBatchParams', () => {
  it('indexes a batch of one, rather than using the bare form', () => {
    const params = scrobbleBatchParams(batchOf(1))

    // Last.fm accepts `artist` without an index for a single scrobble. Using it
    // would mean a parameter shape reachable only when a batch happens to have
    // one element — a path the common case never exercises and an almost-empty
    // queue always does.
    expect(params['artist[0]']).toBe('Talk Talk')
    expect(params['track[0]']).toBe('Track 0')
    expect(params.artist).toBeUndefined()
    expect(params.track).toBeUndefined()
  })

  it('indexes a batch of two independently', () => {
    const params = scrobbleBatchParams(batchOf(2))

    expect(params['track[0]']).toBe('Track 0')
    expect(params['track[1]']).toBe('Track 1')
    expect(params['timestamp[0]']).toBe('1754000000')
    expect(params['timestamp[1]']).toBe('1754000400')
  })

  it('indexes a full batch of fifty without a gap or an overlap', () => {
    const params = scrobbleBatchParams(batchOf(50))

    for (let index = 0; index < 50; index++) {
      expect(params[`track[${index}]`]).toBe(`Track ${index}`)
      expect(params[`timestamp[${index}]`]).toBe(String(1_754_000_000 + index * 400))
    }
    expect(params['track[50]']).toBeUndefined()
    expect(Object.keys(params).filter((key) => key.startsWith('timestamp['))).toHaveLength(50)
  })

  it('sorts array indices as ASCII, which is what the signature depends on', () => {
    // `artist[10]` sorts before `artist[2]`, and that is fine — what matters is
    // that signing and sending agree on the order, which they do because both go
    // through `signedPairs`. Pinned here because a future "sort numerically"
    // tidy-up would break every batch of ten or more with error 13.
    const base = signatureBase(scrobbleBatchParams(batchOf(12)), 'secret')
    expect(base.indexOf('artist[10]')).toBeLessThan(base.indexOf('artist[2]'))
    expect(base.endsWith('secret')).toBe(true)
  })

  it('omits an album artist that only repeats the track artist', () => {
    const same = scrobbleBatchParams([
      { id: 1, payload: payload({ albumArtistName: 'Talk Talk' }) }
    ])
    const different = scrobbleBatchParams([
      { id: 1, payload: payload({ albumArtistName: 'Various Artists' }) }
    ])

    expect(same['albumArtist[0]']).toBeUndefined()
    expect(different['albumArtist[0]']).toBe('Various Artists')
  })

  it('omits a duration it does not have rather than claiming zero', () => {
    const unknown = scrobbleBatchParams([{ id: 1, payload: payload({ durationSeconds: null }) }])
    const zero = scrobbleBatchParams([{ id: 1, payload: payload({ durationSeconds: 0 }) }])

    expect(unknown['duration[0]']).toBeUndefined()
    // `duration=0` is a claim about the track, and the claim is false.
    expect(zero['duration[0]']).toBeUndefined()
  })

  it('omits an empty album rather than sending a blank one', () => {
    const params = scrobbleBatchParams([{ id: 1, payload: payload({ albumTitle: '' }) }])
    expect(params['album[0]']).toBeUndefined()
  })
})

describe('nowPlayingParams', () => {
  it('sends the same fields with no index and no timestamp', () => {
    const { timestamp: _timestamp, ...playing } = payload()
    const params = nowPlayingParams(playing)

    expect(params.artist).toBe('Talk Talk')
    expect(params.album).toBe('Laughing Stock')
    expect(params.duration).toBe('366')
    expect(params.timestamp).toBeUndefined()
    expect(Object.keys(params).some((key) => key.includes('['))).toBe(false)
  })
})

describe('loveParams', () => {
  it('is two fields, because a love is about the song and not the copy', () => {
    // Not `listenFields`. `track.love` has no album, duration or timestamp
    // parameter, so sending one would be signing bytes Last.fm discards.
    expect(loveParams({ artistName: 'Talk Talk', title: 'Ascension Day' })).toEqual({
      artist: 'Talk Talk',
      track: 'Ascension Day'
    })
  })

  it('sends the same parameters whichever direction the toggle went', () => {
    // One builder serves `track.love` and `track.unlove`; the method name is the
    // whole of the difference between them.
    const song = { artistName: 'Talk Talk', title: 'Ascension Day' }
    expect(loveParams(song)).toEqual(loveParams({ ...song }))
  })
})

describe('readScrobbleResponse', () => {
  /** The single-scrobble shape: an object where two would be an array. */
  const oneAccepted = {
    scrobbles: {
      '@attr': { accepted: 1, ignored: 0 },
      scrobble: {
        artist: { corrected: '0', '#text': 'Talk Talk' },
        album: { corrected: '0', '#text': 'Laughing Stock' },
        track: { corrected: '0', '#text': 'Track 0' },
        timestamp: '1754000000',
        ignoredMessage: { code: '0', '#text': '' }
      }
    }
  }

  it('reads the single-scrobble object, not only the array', () => {
    const reading = readScrobbleResponse(oneAccepted, batchOf(1))
    expect(reading).toEqual({ ok: true, results: [{ id: 100, accepted: true }] })
  })

  it('accepts every row of a full-accept batch', () => {
    const batch = batchOf(3)
    const reading = readScrobbleResponse(
      {
        scrobbles: {
          '@attr': { accepted: 3, ignored: 0 },
          scrobble: batch.map(({ payload: item }) => ({
            timestamp: String(item.timestamp),
            ignoredMessage: { code: '0', '#text': '' }
          }))
        }
      },
      batch
    )

    expect(reading).toEqual({
      ok: true,
      results: [
        { id: 100, accepted: true },
        { id: 101, accepted: true },
        { id: 102, accepted: true }
      ]
    })
  })

  it('reports a partial accept per row, with a reason a person can read', () => {
    const batch = batchOf(3)
    const reading = readScrobbleResponse(
      {
        scrobbles: {
          '@attr': { accepted: 2, ignored: 1 },
          scrobble: [
            { timestamp: String(batch[0].payload.timestamp), ignoredMessage: { code: '0' } },
            {
              timestamp: String(batch[1].payload.timestamp),
              ignoredMessage: { code: '1', '#text': 'Artist ignored' }
            },
            { timestamp: String(batch[2].payload.timestamp), ignoredMessage: { code: '0' } }
          ]
        }
      },
      batch
    )

    expect(reading.ok).toBe(true)
    if (!reading.ok) return
    expect(reading.results).toEqual([
      { id: 100, accepted: true },
      { id: 101, accepted: false, reason: 'Last.fm does not index this artist name.' },
      { id: 102, accepted: true }
    ])
  })

  it('fails the whole call on the daily limit rather than dropping the rows', () => {
    const batch = batchOf(2)
    const reading = readScrobbleResponse(
      {
        scrobbles: {
          scrobble: [
            { timestamp: String(batch[0].payload.timestamp), ignoredMessage: { code: '0' } },
            {
              timestamp: String(batch[1].payload.timestamp),
              ignoredMessage: { code: String(LASTFM_IGNORED.dailyLimitExceeded) }
            }
          ]
        }
      },
      batch
    )

    // A quota passes on its own by tomorrow. Reporting it as `accepted: false`
    // would delete a listen that would have gone through — so it is a whole-call
    // `rate-limited`, which the drain worker already knows to back off.
    expect(reading).toEqual({
      ok: false,
      failure: {
        kind: 'rate-limited',
        message: 'Last.fm’s daily scrobble limit has been reached. Fermata will try again later.'
      }
    })
  })

  it('leaves a row unanswered rather than attributing a shifted reply to it', () => {
    const batch = batchOf(3)
    const reading = readScrobbleResponse(
      {
        scrobbles: {
          // Last.fm dropped the middle entry, so positions 1 and 2 of the reply
          // belong to submissions 2 and — nothing. Believing the position would
          // delete row 101 on the strength of row 102's result.
          scrobble: [
            { timestamp: String(batch[0].payload.timestamp), ignoredMessage: { code: '0' } },
            { timestamp: String(batch[2].payload.timestamp), ignoredMessage: { code: '0' } }
          ]
        }
      },
      batch
    )

    expect(reading).toEqual({ ok: true, results: [{ id: 100, accepted: true }] })
  })

  it('ignores entries beyond the batch it was asked about', () => {
    const batch = batchOf(1)
    const reading = readScrobbleResponse(
      {
        scrobbles: {
          scrobble: [
            { timestamp: String(batch[0].payload.timestamp), ignoredMessage: { code: '0' } },
            { timestamp: '999', ignoredMessage: { code: '0' } }
          ]
        }
      },
      batch
    )

    expect(reading).toEqual({ ok: true, results: [{ id: 100, accepted: true }] })
  })

  it('calls a body with no scrobbles element malformed', () => {
    for (const body of [{}, { scrobbles: 'yes' }, { scrobbles: { '@attr': { accepted: 1 } } }]) {
      const reading = readScrobbleResponse(body as never, batchOf(1))
      expect(reading).toMatchObject({ ok: false, failure: { kind: 'malformed' } })
    }
  })

  it('accepts a row whose ignoredMessage is absent entirely', () => {
    // Not every deployment sends one. An entry that came back with no complaint
    // attached is an accepted scrobble, and treating it as unreadable would
    // retry a listen Last.fm already has.
    const batch = batchOf(1)
    const reading = readScrobbleResponse(
      { scrobbles: { scrobble: { timestamp: String(batch[0].payload.timestamp) } } },
      batch
    )
    expect(reading).toEqual({ ok: true, results: [{ id: 100, accepted: true }] })
  })
})
