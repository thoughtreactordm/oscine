/**
 * The one socket scrobbling opens, and the one exemption in Fermata's consent
 * gate — **D19**.
 *
 * ## The gate a reader will look for here, and why it is absent
 *
 * Every other outbound request in this app goes through a `NetClient` built with
 * `createNetworkConsent(settings)`, which reads D14's `network.externalLookups`
 * before opening anything. This one is built with `CONSENT_GRANTED`, and that is
 * not an oversight — it is the position D19 argues, stated at the line that
 * implements it.
 *
 * D14's toggle governs the lookups *Fermata* decides to make: it sends the
 * playing artist's name to MusicBrainz because it wants a biography, on its own
 * initiative, without being asked. Scrobbling is the opposite in every respect
 * that matters. Nothing outbound happens until the operator has signed into
 * their own Last.fm account, on Last.fm's own page, in their own browser, having
 * clicked Connect in a pane that says what connecting does — and the credential
 * that results is the only thing that makes a scrobble possible at all. That is
 * a stronger and far more specific act of consent than a checkbox naming a
 * service, and making it *also* depend on a general network toggle would mean an
 * operator who deliberately connected an account watched their listens silently
 * not arrive.
 *
 * The gate that is really in force here is `credentials.read()` returning
 * `null`, which it does until the sign-in completes and again the moment the
 * operator disconnects.
 *
 * Everything else about the shared client is kept: the same scope registry, so
 * `NET_SCOPES`' `'scrobble'` cancels a drain the same way it cancels a deck; the
 * same rate limiter instance, so per-host spacing is a property of the process
 * and not of one client; the same deadlines, retry ladder and user agent.
 *
 * ## `acceptStatuses`
 *
 * Last.fm answers a failed call with `403` and a document naming the error, and
 * the document is the answer — error 14 means "the operator has not clicked
 * Allow yet" and error 10 means "that key is not valid", which are a wait and a
 * stop respectively. See `NetGetRequest.acceptStatuses`.
 */

import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import { createNetClient, CONSENT_GRANTED, type NetClient } from '../../net'
import type { RateLimiter } from '../../net/rateLimiter'
import type { ScopeRegistry } from '../../net/scopes'
import { withSignature, type LastfmParams } from './signature'

export const LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/'

/**
 * Statuses whose body is a Last.fm error document rather than a refusal.
 *
 * Measured against the live API rather than guessed at, and it uses more than
 * one: `auth.getSession` with a signature it accepts and a token nobody has
 * approved answers **403** with error 14, while the same call with a wrong
 * signature answers **400** with error 13. Those two are the auth flow's wait
 * and its stop, so a list that covered only 403 would turn a mis-signed request
 * into a bare `rejected` — the exact failure this stream is meant not to spend a
 * day on. `401` is included for the same envelope; it costs nothing to read.
 *
 * `404` is deliberately absent: a 404 from this endpoint means the API root
 * moved, which is a Fermata bug rather than a message for the operator.
 */
const LASTFM_ERROR_STATUSES = [400, 401, 403] as const

/**
 * The error codes this stream reasons about by number.
 *
 * Only the ones with distinct *behaviour* are named. Last.fm defines a couple of
 * dozen; the rest are all "this request was wrong", which is one behaviour and
 * needs no constant. W11-4 adds nothing to this list — 9 and 29 are already
 * here, and its taxonomy is the mapping below rather than more names.
 */
export const LASTFM_ERROR = {
  /** Authentication failed: the credentials do not identify anyone. */
  authenticationFailed: 4,
  /** The parameters were wrong. Terminal for the call that sent them. */
  invalidParameters: 6,
  /** Transient on Last.fm's side, despite the name. */
  operationFailed: 8,
  /** The session key is no longer valid. Terminal for the *account*. */
  invalidSessionKey: 9,
  /** The API key is not valid. Terminal, and a configuration problem. */
  invalidApiKey: 10,
  serviceOffline: 11,
  /** The signature did not verify. Almost always a bug here, not a bad secret. */
  invalidMethodSignature: 13,
  /** The token has not been authorized yet — the operator is still in the browser. */
  unauthorizedToken: 14,
  /** The token expired before it was used. Start the flow again. */
  tokenExpired: 15,
  temporarilyUnavailable: 16,
  suspendedApiKey: 26,
  rateLimitExceeded: 29
} as const

/**
 * A call's outcome, with Last.fm's error number kept alongside the failure.
 *
 * Structurally a `NetResult<T>` — the extra field sits on the failure arm — so
 * it can be returned straight from anything that owes a `NetResult` while the
 * auth flow, which is the one caller that needs to tell error 14 from error 10,
 * can still see the number.
 */
export type LastfmCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: NetFailure; readonly code: number | null }

/** The envelope Last.fm sends instead of a result. */
interface LastfmErrorBody {
  error?: unknown
  message?: unknown
}

/**
 * Last.fm's numbered errors, mapped onto the vocabulary the rest of Fermata
 * already speaks.
 *
 * The mapping is the error taxonomy W11-4's drain worker acts on, and it lives
 * here rather than there because the numbers are a fact about this service. What
 * the drain does with `rate-limited` versus `rejected` is a fact about outboxes.
 */
function failureForCode(code: number | null, message: string): NetFailure {
  switch (code) {
    case LASTFM_ERROR.operationFailed:
    case LASTFM_ERROR.serviceOffline:
    case LASTFM_ERROR.temporarilyUnavailable:
      return { kind: 'unavailable', message: 'Last.fm is temporarily unavailable.' }

    case LASTFM_ERROR.rateLimitExceeded:
      return { kind: 'rate-limited', message: 'Last.fm asked us to slow down.' }

    case LASTFM_ERROR.invalidSessionKey:
      return {
        kind: 'rejected',
        message: 'Last.fm no longer accepts this sign-in. Reconnect the account.'
      }

    case LASTFM_ERROR.authenticationFailed:
      return { kind: 'rejected', message: 'Last.fm did not accept the sign-in.' }

    case LASTFM_ERROR.invalidApiKey:
    case LASTFM_ERROR.suspendedApiKey:
      return {
        kind: 'rejected',
        message:
          'Last.fm rejected this application’s API key. If you entered your own in ' +
          'Settings › Network, check it; otherwise this build’s key needs replacing.'
      }

    case LASTFM_ERROR.invalidMethodSignature:
      return {
        kind: 'rejected',
        message: 'Last.fm rejected the request signature. Check the shared secret.'
      }

    case LASTFM_ERROR.unauthorizedToken:
      return { kind: 'rejected', message: 'Nobody has approved this sign-in request yet.' }

    case LASTFM_ERROR.tokenExpired:
      return { kind: 'rejected', message: 'The sign-in request expired. Try connecting again.' }

    default:
      // Including `null`: a 403 whose body was not an error envelope at all.
      // `message` is Last.fm's own text when there was one, which is more use
      // than anything this function could invent for an unknown number.
      return { kind: 'rejected', message: message || 'Last.fm refused the request.' }
  }
}

export interface LastfmTransport {
  /**
   * One signed call, as JSON.
   *
   * `format` and `api_sig` are added here; the caller passes the method's own
   * parameters and nothing else. Every call this stream makes is signed —
   * `auth.getToken` included, which Last.fm permits unsigned but which costs
   * nothing to sign and removes a second code path.
   */
  call<T>(params: LastfmParams): Promise<LastfmCallResult<T>>

  /**
   * The same call as a form POST, for the methods that write.
   *
   * Signed identically — one `withSignature`, so the rule that `format` is
   * excluded cannot hold on one path and not the other. What changes is where
   * the parameters go, and there are three reasons they go in a body:
   *
   * 1. **Last.fm requires it** of its write methods. `track.scrobble` sent as a
   *    GET is refused, and refused in the shape of a generic error rather than
   *    of an explanation.
   * 2. **Size.** Fifty scrobbles is fifty artists, titles, albums, album
   *    artists, durations and timestamps — three hundred parameters, comfortably
   *    past any length a query string is guaranteed.
   * 3. **The session key.** `sk` is on every one of these calls, and a URL is
   *    the one part of a request that gets written down by things that are not
   *    the two endpoints — proxies, access logs, error reporters. The body is
   *    not secret either, but it is not routinely archived.
   *
   * `auth.getToken` and `auth.getSession` stay on `call`: Last.fm documents both
   * as GET, W11-3 verified them that way against the live API, and neither
   * carries a session key.
   *
   * **One attempt.** The client's retry ladder is switched off here because a
   * POST that fails after Last.fm has recorded it is indistinguishable from one
   * that never arrived, and the outbox is already a durable retry with its own
   * backoff (W11-2). Retrying inside the client would risk a duplicate scrobble
   * to save a round trip the queue was going to make anyway.
   */
  post<T>(params: LastfmParams): Promise<LastfmCallResult<T>>
}

export interface LastfmTransportOptions {
  /** Shared, never a second instance — see `NetService.limiter`. */
  limiter: RateLimiter
  /** Shared, so `cancelScope('scrobble')` reaches these requests. */
  scopes: ScopeRegistry
  /** The shared secret to sign with. Read per call so an override takes effect live. */
  sharedSecret: () => string
  /** Injected for tests; the real one is built here. */
  client?: NetClient
}

export function createLastfmTransport({
  limiter,
  scopes,
  sharedSecret,
  client
}: LastfmTransportOptions): LastfmTransport {
  const net =
    client ??
    createNetClient({
      // The exemption. See the note at the top of this file, and D19.
      consent: CONSENT_GRANTED,
      limiter,
      scopes
    })

  /**
   * Turn a reply into an outcome, for both verbs.
   *
   * Shared rather than duplicated because the error envelope is a property of
   * the API and not of the method used to reach it — a `track.scrobble` that
   * fails on a dead session gets the same error 9 document as a GET would.
   */
  function interpret<T>(result: NetResult<T & LastfmErrorBody>): LastfmCallResult<T> {
    if (!result.ok) return { ok: false, failure: result.failure, code: null }

    // Checked on success as well as on the accepted error statuses: Last.fm
    // has been known to answer `200` with an error envelope, and a caller that
    // trusted the status would read the absence of its expected field as a
    // parse failure and report "unreadable" for a perfectly clear "error 14".
    const body = result.value
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const raw = body.error
      const code = typeof raw === 'number' ? raw : null
      const message = typeof body.message === 'string' ? body.message : ''
      return { ok: false, failure: failureForCode(code, message), code }
    }

    return { ok: true, value: body }
  }

  return {
    async call<T>(params: LastfmParams): Promise<LastfmCallResult<T>> {
      const search = withSignature(params, sharedSecret())
      return interpret(
        await net.getJson<T & LastfmErrorBody>({
          url: `${LASTFM_API_ROOT}?${search.toString()}`,
          scope: 'scrobble',
          acceptStatuses: LASTFM_ERROR_STATUSES
        })
      )
    },

    async post<T>(params: LastfmParams): Promise<LastfmCallResult<T>> {
      return interpret(
        await net.postJson<T & LastfmErrorBody>({
          url: LASTFM_API_ROOT,
          form: withSignature(params, sharedSecret()),
          scope: 'scrobble',
          acceptStatuses: LASTFM_ERROR_STATUSES,
          // See `LastfmTransport.post`: the outbox is the retry ladder.
          maxAttempts: 1
        })
      )
    }
  }
}

/** Drop the error code, for the callers that owe a plain `NetResult`. */
export function toNetResult<T>(result: LastfmCallResult<T>): NetResult<T> {
  return result.ok ? netOk(result.value) : netFailed(result.failure)
}
