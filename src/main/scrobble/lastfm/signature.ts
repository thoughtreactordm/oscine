/**
 * Last.fm's request signature, and the two ways to get it silently wrong.
 *
 * `api_sig = md5(<every parameter's name and value, sorted by name, joined with
 * nothing> + <shared secret>)`, hex, lower case. There is no separator anywhere:
 * not between a name and its value, not between pairs, not before the secret.
 *
 * A wrong signature does not come back as "wrong signature". It comes back as
 * error 13, "invalid method signature", which reads exactly like a wrong secret,
 * a wrong key, an expired token or a clock problem — so this is the one piece of
 * the client worth pinning to a vector computed by something that is not this
 * code. `signature.test.ts` does that, and `track.scrobble` signs through this
 * same function rather than having grown its own.
 *
 * ## The two omissions
 *
 * **`format` is excluded.** It is a transport instruction to the API gateway,
 * not a parameter of the method, and including it fails every signed call while
 * looking like a credentials problem. It is dropped here rather than left to
 * each caller to remember, because a caller who forgets gets error 13.
 *
 * **`api_sig` itself is excluded**, which cannot be otherwise but is worth the
 * guard: the natural way to write a caller is to build the parameter object,
 * sign it, then add the signature to the same object — and if that object were
 * ever signed twice the second signature would cover the first.
 *
 * ## Sorting
 *
 * By parameter name, ASCII. JavaScript's default sort compares UTF-16 code
 * units, which is the same ordering for every name Last.fm defines — they are
 * all ASCII, including W11-4's array-indexed `artist[0]`. Values may be any
 * text; only names are sorted and only names have to be ASCII.
 */

import { createHash } from 'node:crypto'

/**
 * Parameters excluded from the signature.
 *
 * `callback` joins them if JSONP ever appears, which it will not.
 */
const UNSIGNED_PARAMETERS = new Set(['format', 'api_sig', 'callback'])

/**
 * A method's parameters. `undefined` values are dropped rather than sent empty —
 * an absent optional field and a field sent as the empty string are different
 * requests to Last.fm, and the caller almost always means the former.
 */
export type LastfmParams = Readonly<Record<string, string | undefined>>

/** Just the parameters that are sent and signed, in signing order. */
function signedPairs(params: LastfmParams): [string, string][] {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(([name]) => !UNSIGNED_PARAMETERS.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The string that is hashed, exposed so a test can assert the concatenation
 * separately from the digest.
 *
 * Worth splitting out: if only the hex output is ever checked, a failing test
 * says "the signature is wrong" and leaves the reader to work out whether the
 * ordering, the joining or the secret is at fault.
 */
export function signatureBase(params: LastfmParams, sharedSecret: string): string {
  return signedPairs(params)
    .map(([name, value]) => `${name}${value}`)
    .join('')
    .concat(sharedSecret)
}

/** `api_sig` for a call. Lower-case hex, as Last.fm sends and expects. */
export function signParams(params: LastfmParams, sharedSecret: string): string {
  return createHash('md5').update(signatureBase(params, sharedSecret), 'utf8').digest('hex')
}

/**
 * The parameters as they go on the wire: the signed set, plus `api_sig`, plus
 * `format=json`.
 *
 * One function so that the two rules — sign without `format`, send with it —
 * cannot be applied in the wrong order by a caller doing it by hand.
 */
export function withSignature(params: LastfmParams, sharedSecret: string): URLSearchParams {
  const search = new URLSearchParams()
  for (const [name, value] of signedPairs(params)) search.set(name, value)
  search.set('api_sig', signParams(params, sharedSecret))
  search.set('format', 'json')
  return search
}
