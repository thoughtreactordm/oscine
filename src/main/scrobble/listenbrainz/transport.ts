/**
 * The one socket ListenBrainz opens — **D19**, W11-8.
 *
 * ## The same exemption, stated once more one target over
 *
 * Like Last.fm's, this client is built with `CONSENT_GRANTED` rather than through
 * D14's `network.externalLookups` gate, for the reason argued at length at the
 * top of `scrobble/lastfm/transport.ts`: scrobbling is not a lookup Oscine
 * decides to make on the operator's behalf, it is the operator having signed in
 * to an account of their own, and the gate that is really in force is
 * `credentials.read()` returning `null` until they have. The limiter and the
 * scope registry are the shared instances, so per-host spacing is a property of
 * the process and `cancelScope('scrobble')` abandons a ListenBrainz submit the
 * same way it abandons a Last.fm one.
 *
 * ## Where this differs, which is the whole reason W11-8 exists
 *
 * There is no signature, no app key and no shared secret — the abstraction's
 * signing machinery is Last.fm's and it stays in Last.fm's folder. Authentication
 * is a single header, `Authorization: Token <user token>`, carried on every call
 * through the net client's `headers` (added for exactly this). And the error
 * model is HTTP status rather than a numbered document: a `401` is the dead
 * credential that Last.fm signals with error 9, a `400` is the unparseable
 * request that Last.fm signals with error 6, and everything transient — `429`,
 * `503`, a dropped connection — the shared client already classifies before this
 * file is consulted. So this transport surfaces the status and lets the target
 * decide, the same division of labour `LastfmCallResult` strikes with its code.
 */

import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import { createNetClient, CONSENT_GRANTED, type NetClient } from '../../net'
import type { RateLimiter } from '../../net/rateLimiter'
import type { ScopeRegistry } from '../../net/scopes'
import type { ListenbrainzSubmitBody } from './listens'

export const LISTENBRAINZ_API_ROOT = 'https://api.listenbrainz.org'
export const LISTENBRAINZ_SUBMIT_URL = `${LISTENBRAINZ_API_ROOT}/1/submit-listens`
export const LISTENBRAINZ_VALIDATE_URL = `${LISTENBRAINZ_API_ROOT}/1/validate-token`

/**
 * The statuses whose body is a ListenBrainz error envelope worth reading rather
 * than a bare refusal — its `{ code, error }` document, in the shape of Last.fm's
 * `acceptStatuses`.
 *
 * `401` and `400` only: the one is a token the service no longer accepts and the
 * other a request it will not parse, and telling them apart is the difference
 * between disconnecting the account and dropping one batch. Every transient
 * status is left to the shared client, which backs off on it — listing one here
 * would be opting a submit out of its own retry.
 */
const LISTENBRAINZ_ERROR_STATUSES = [400, 401] as const

/** Who a token belongs to, as `validate-token` reports it. */
export interface ListenbrainzIdentity {
  readonly userName: string
}

/**
 * A write's outcome, with the HTTP status kept alongside the failure.
 *
 * Structurally the failure arm of a `NetResult` plus the status the target needs
 * to choose a behaviour: `401` disconnects the account, `400` rejects the batch,
 * and a `null` status is a transient network failure the target retries whole.
 */
export type ListenbrainzWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: NetFailure; readonly status: number | null }

/** ListenBrainz's error envelope, and the fields of a `validate-token` reply. */
interface ListenbrainzBody {
  code?: unknown
  error?: unknown
  status?: unknown
  valid?: unknown
  user_name?: unknown
}

export interface ListenbrainzTransport {
  /**
   * Ask whether a token names an account. Resolves with the account name on a
   * token the service accepts, and a `rejected` failure on one it does not — a
   * `valid: false` reply and a `401` are the same answer to the operator.
   */
  validateToken(token: string): Promise<NetResult<ListenbrainzIdentity>>

  /**
   * Submit a body already shaped by `listens.ts`. One attempt: the outbox is the
   * durable retry (W11-2), and a POST retried after the server has recorded it is
   * a duplicate listen to save a round trip the queue was going to make anyway.
   */
  submit(token: string, body: ListenbrainzSubmitBody): Promise<ListenbrainzWriteResult>
}

export interface ListenbrainzTransportOptions {
  /** Shared, never a second instance — see `NetService.limiter`. */
  limiter: RateLimiter
  /** Shared, so `cancelScope('scrobble')` reaches these requests. */
  scopes: ScopeRegistry
  /** Injected for tests; the real one is built here. */
  client?: NetClient
}

const authHeaders = (token: string): Record<string, string> => ({
  authorization: `Token ${token}`
})

/** ListenBrainz's operator-facing prose, mapped from the status it refused with. */
function failureForStatus(status: number | null, message: string): NetFailure {
  switch (status) {
    case 401:
      return {
        kind: 'rejected',
        message: 'ListenBrainz no longer accepts this token. Reconnect the account.'
      }
    case 400:
      return {
        kind: 'rejected',
        message: message || 'ListenBrainz could not read this listen.'
      }
    default:
      return { kind: 'rejected', message: message || 'ListenBrainz refused the request.' }
  }
}

export function createListenbrainzTransport({
  limiter,
  scopes,
  client
}: ListenbrainzTransportOptions): ListenbrainzTransport {
  const net =
    client ??
    createNetClient({
      // The exemption. See the top of this file, `scrobble/lastfm/transport.ts`,
      // and D19.
      consent: CONSENT_GRANTED,
      limiter,
      scopes
    })

  return {
    async validateToken(token: string): Promise<NetResult<ListenbrainzIdentity>> {
      const result = await net.getJson<ListenbrainzBody>({
        url: LISTENBRAINZ_VALIDATE_URL,
        scope: 'scrobble',
        headers: authHeaders(token),
        acceptStatuses: LISTENBRAINZ_ERROR_STATUSES
      })
      if (!result.ok) return netFailed(result.failure)

      const body = result.value
      if (body.valid === true && typeof body.user_name === 'string' && body.user_name !== '') {
        return netOk({ userName: body.user_name })
      }
      // `valid: false`, or the `{ code: 401 }` envelope of a token the header did
      // not authenticate — one message, because the operator's next move is the
      // same either way: paste a token that works.
      return netFailed({
        kind: 'rejected',
        message: 'ListenBrainz did not recognise that token. Check it and try again.'
      })
    },

    async submit(token: string, body: ListenbrainzSubmitBody): Promise<ListenbrainzWriteResult> {
      const result = await net.postJson<ListenbrainzBody>({
        url: LISTENBRAINZ_SUBMIT_URL,
        json: body,
        scope: 'scrobble',
        headers: authHeaders(token),
        acceptStatuses: LISTENBRAINZ_ERROR_STATUSES,
        // The outbox is the retry ladder — see `ListenbrainzTransport.submit`.
        maxAttempts: 1
      })

      // A transient failure the shared client already classified (429, 5xx,
      // offline, timeout): no status of ours to add, and the target retries the
      // whole batch on it.
      if (!result.ok) return { ok: false, failure: result.failure, status: null }

      // An accepted 400/401 arrives as a readable body carrying `error`; a real
      // acceptance is `{ status: 'ok' }` with neither `error` nor a non-200
      // `code`. Checked on the body rather than the HTTP status because the net
      // client returns the former and hides the latter.
      const envelope = result.value
      const hasError = typeof envelope.error === 'string'
      const code = typeof envelope.code === 'number' ? envelope.code : null
      if (hasError || (code !== null && code !== 200)) {
        const message = typeof envelope.error === 'string' ? envelope.error : ''
        return { ok: false, failure: failureForStatus(code, message), status: code }
      }

      return { ok: true }
    }
  }
}
