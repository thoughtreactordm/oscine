import type { ArtistCandidate, ArtistResolution } from '@shared/artist'
import { describe, expect, it } from 'vitest'
import {
  describeCandidate,
  describeIdentity
} from '../../../src/renderer/panels/tunedeck/artistIdentity'

/**
 * What the deck *claims*, which is the thing **R5** is a risk about.
 *
 * A confident, wrong biography is worse than none — and the sentence in the
 * header is where confidence is expressed. So these are assertions about wording
 * as much as about branching: that an unresolved artist reads as a state rather
 * than as a failure, that a corrected one says whose choice it was, and that a
 * declined lookup does not offer a retry which cannot possibly work.
 */

const MBID = '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6'

function candidate(overrides: Partial<ArtistCandidate> = {}): ArtistCandidate {
  return {
    mbid: MBID,
    name: 'Nirvana',
    sortName: 'Nirvana',
    disambiguation: null,
    country: null,
    type: null,
    begin: null,
    end: null,
    score: 100,
    ...overrides
  }
}

function resolution(overrides: Partial<ArtistResolution> = {}): ArtistResolution {
  return {
    artistId: 1,
    name: 'Nirvana',
    query: 'Nirvana',
    status: 'ambiguous',
    mbid: null,
    source: null,
    candidates: [],
    failure: null,
    ...overrides
  }
}

describe('describeCandidate', () => {
  it('leads with MusicBrainz’s own disambiguation comment, alone', () => {
    expect(
      describeCandidate(
        candidate({ disambiguation: '1980s–1990s US grunge band', country: 'US', type: 'Group' })
      )
    ).toBe('1980s–1990s US grunge band')
  })

  it('falls back to kind, country and years for artists nobody annotated', () => {
    expect(
      describeCandidate(
        candidate({ type: 'Group', country: 'GB', begin: '1965-04-01', end: '1971' })
      )
    ).toBe('Group · GB · 1965–1971')
  })

  it('renders an open-ended life span', () => {
    expect(describeCandidate(candidate({ begin: '1994' }))).toBe('1994–')
  })

  it('says nothing rather than something empty', () => {
    expect(describeCandidate(candidate())).toBeNull()
  })
})

describe('describeIdentity', () => {
  it('names the MusicBrainz spelling once resolved', () => {
    const wording = describeIdentity(
      resolution({
        status: 'resolved',
        mbid: MBID,
        source: 'auto',
        candidates: [candidate({ name: 'Godspeed You! Black Emperor', mbid: MBID })]
      })
    )

    expect(wording.headline).toBe('Godspeed You! Black Emperor')
    expect(wording.tone).toBe('resolved')
    // Present even when we are confident: the affordance R5 asks for exists for
    // the case where the deck is confident and wrong.
    expect(wording.correctable).toBe(true)
    expect(wording.retryable).toBe(false)
  })

  /**
   * The common case says nothing, on purpose.
   *
   * "Matched on MusicBrainz." was true, permanent and identical for almost every
   * artist in a library — a line of grey text under the name that the tick
   * beside it already carried. The header renders no second line at all for it.
   */
  it('adds no detail to a plain automatic match', () => {
    const wording = describeIdentity(
      resolution({
        status: 'resolved',
        mbid: MBID,
        source: 'auto',
        candidates: [candidate({ mbid: MBID })]
      })
    )

    expect(wording.detail).toBeNull()
  })

  /** The one line that distinguishes this Nirvana from the other ten. It stays. */
  it('keeps a disambiguation, which is the detail that varies', () => {
    const wording = describeIdentity(
      resolution({
        status: 'resolved',
        mbid: MBID,
        source: 'auto',
        candidates: [candidate({ mbid: MBID, disambiguation: '1980s–90s US grunge band' })]
      })
    )

    expect(wording.detail).toBe('1980s–90s US grunge band')
  })

  it('says whose choice it was when the operator made it', () => {
    const wording = describeIdentity(
      resolution({ status: 'resolved', mbid: MBID, source: 'manual', candidates: [candidate()] })
    )

    expect(wording.detail).toBe('Your choice. Kept until you change it.')
  })

  /** The Nirvana state: a first-class one, with the way out named in the line. */
  it('renders ambiguity as a state with an instruction, not an error', () => {
    const wording = describeIdentity(resolution({ candidates: [candidate(), candidate()] }))

    expect(wording.tone).toBe('unresolved')
    expect(wording.headline).toBe('Nirvana')
    expect(wording.detail).toContain('Pick the right one')
    expect(wording.correctable).toBe(true)
  })

  it('distinguishes "MusicBrainz has nothing" from "you said so"', () => {
    expect(describeIdentity(resolution({ status: 'no-match' })).detail).toBe(
      'Not on MusicBrainz under this name.'
    )
    expect(describeIdentity(resolution({ status: 'no-match', source: 'manual' })).detail).toBe(
      'You said this artist is not on MusicBrainz.'
    )
  })

  /**
   * The live-probe correction. MusicBrainz answers an unknown name with near
   * misses rather than with nothing, so "no match" usually still has a list
   * behind it — and an operator told the artist is simply absent has no reason
   * to open the picker where the right one may be sitting third.
   */
  it('points at the near misses when there are some', () => {
    const wording = describeIdentity(
      resolution({ status: 'no-match', candidates: [candidate({ name: 'Tapedeck', score: 62 })] })
    )

    expect(wording.detail).toBe('No close match. Look through the near misses?')
    expect(wording.correctable).toBe(true)
  })

  /**
   * Main's sentence, not a second copy of it. Rewording here would be a second
   * place for "lookups are off" to be spelled differently.
   */
  it('repeats main’s phrasing for a failure', () => {
    const wording = describeIdentity(
      resolution({
        status: 'unavailable',
        failure: { kind: 'offline', message: 'Could not reach the service.' }
      })
    )

    expect(wording.detail).toBe('Could not reach the service.')
    expect(wording.tone).toBe('problem')
    expect(wording.retryable).toBe(true)
  })

  it('offers no retry when consent is what is missing', () => {
    const wording = describeIdentity(
      resolution({
        status: 'unavailable',
        failure: { kind: 'declined', message: 'Online lookups are off.' }
      })
    )

    // A Retry that is guaranteed to fail is worse than no Retry: the operator
    // presses it, nothing changes, and the app looks broken rather than off.
    expect(wording.retryable).toBe(false)
    expect(wording.correctable).toBe(true)
  })

  it('has something to say for a track with no artist at all', () => {
    const wording = describeIdentity(null)

    expect(wording.headline).toBe('No artist')
    expect(wording.correctable).toBe(false)
    expect(wording.retryable).toBe(false)
  })

  it('reports a rejected call as ours rather than as the service’s', () => {
    const wording = describeIdentity(resolution(), { failed: true })

    expect(wording.detail).toBe('Oscine could not look this up.')
    expect(wording.tone).toBe('problem')
  })
})
