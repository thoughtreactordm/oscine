/**
 * The signature, pinned to vectors computed outside this codebase.
 *
 * The expected digests below were produced by piping the concatenation through
 * `md5sum`, not by running `signParams` and copying what came out. That
 * distinction is the entire value of this file: a wrong signature comes back
 * from Last.fm as error 13, "invalid method signature", which is
 * indistinguishable from a wrong shared secret, a wrong API key or a broken
 * clock — and W11-4's card budgets a day for getting it wrong. A test that
 * asserted the implementation against itself would agree with every one of
 * those days.
 */

import { describe, expect, it } from 'vitest'
import {
  signParams,
  signatureBase,
  withSignature
} from '../../../src/main/scrobble/lastfm/signature'

const SECRET = 'sharedsecret'

const GET_SESSION = {
  method: 'auth.getSession',
  api_key: 'abcdef',
  token: '0123456789',
  // Present so the exclusion is exercised by the vector rather than only by the
  // test below that names it.
  format: 'json'
}

/** `md5sum` of `api_keyabcdefmethodauth.getSessiontoken0123456789sharedsecret`. */
const GET_SESSION_SIG = '7a34b1c6ed99d8dc3d87c1250f1bed2b'

const SCROBBLE = {
  method: 'track.scrobble',
  api_key: 'abcdef',
  sk: '9f8e7d',
  'artist[0]': 'Sigur Rós',
  'track[0]': 'Hoppípolla',
  'timestamp[0]': '1700000000'
}

/**
 * `md5sum` of the concatenation with the non-ASCII values in UTF-8.
 *
 * A shape W11-4 sends and this card does not, included here because the
 * encoding question only shows up with accented characters and the moment to
 * settle it is before there is a scrobble path to blame instead.
 */
const SCROBBLE_SIG = '770263fa0d7075eddf59de858caf4b3a'

describe('signatureBase', () => {
  it('sorts by name, joins with nothing and appends the secret', () => {
    expect(signatureBase(GET_SESSION, SECRET)).toBe(
      'api_keyabcdefmethodauth.getSessiontoken0123456789sharedsecret'
    )
  })

  it('excludes format and api_sig', () => {
    expect(signatureBase({ method: 'x', format: 'json', api_sig: 'stale' }, SECRET)).toBe(
      'methodxsharedsecret'
    )
  })

  it('drops undefined values rather than sending them empty', () => {
    expect(signatureBase({ method: 'x', album: undefined }, SECRET)).toBe('methodxsharedsecret')
  })

  /**
   * `api_key` sorts before `artist[0]` — `p` before `r` — which is exactly the
   * kind of ordering a reader checks by eye and gets wrong. Asserted on the base
   * string as well as on the digest so that when it does go wrong, the failure
   * says which pair swapped rather than only that a hash differs.
   */
  it('sorts array-indexed names as plain strings', () => {
    expect(signatureBase(SCROBBLE, '')).toBe(
      'api_keyabcdefartist[0]Sigur Rósmethodtrack.scrobblesk9f8e7dtimestamp[0]1700000000track[0]Hoppípolla'
    )
  })
})

describe('signParams', () => {
  it('matches the known-good vector for auth.getSession', () => {
    expect(signParams(GET_SESSION, SECRET)).toBe(GET_SESSION_SIG)
  })

  it('matches the known-good vector for a UTF-8 batch', () => {
    expect(signParams(SCROBBLE, SECRET)).toBe(SCROBBLE_SIG)
  })

  it('is unchanged by a stale api_sig already on the parameters', () => {
    expect(signParams({ ...GET_SESSION, api_sig: 'nonsense' }, SECRET)).toBe(GET_SESSION_SIG)
  })

  it('changes when the secret changes', () => {
    expect(signParams(GET_SESSION, 'other')).not.toBe(GET_SESSION_SIG)
  })
})

describe('withSignature', () => {
  it('sends format and api_sig, having signed without either', () => {
    const search = withSignature(GET_SESSION, SECRET)
    expect(search.get('format')).toBe('json')
    expect(search.get('api_sig')).toBe(GET_SESSION_SIG)
    expect(search.get('method')).toBe('auth.getSession')
  })

  it('omits parameters that were undefined', () => {
    const search = withSignature({ method: 'x', album: undefined }, SECRET)
    expect(search.has('album')).toBe(false)
  })
})
