/**
 * The vocabulary of Fermata's outbound requests, shared by both processes.
 *
 * Main does the fetching (**D14**); the renderer only ever sees what came back.
 * What crosses the boundary is this file's `NetResult` — a value, never an
 * exception. W7-7's acceptance is explicit about that: offline, timeout, 503 and
 * rate-limited are all *states a pane renders*, and a pane that has to wrap
 * every lookup in `try` will eventually forget one and blank itself on a flaky
 * connection.
 *
 * This module must stay free of any Node or Electron import: the renderer
 * imports it, and the renderer has no sockets.
 */

/**
 * Why a request did not produce an answer.
 *
 * The list is deliberately about *what the operator should be told*, not about
 * HTTP. Three different status codes that all mean "the service is having a bad
 * day and it is not your fault" collapse to `unavailable`, because a pane that
 * renders 502 differently from 503 is a pane leaking its transport.
 *
 * `not-found` is the one that is not really a failure. It means the service
 * answered, and the answer was that it has nothing — which for R5's unmatchable
 * artists is the common case, is worth caching negatively (W7-8), and should
 * read as "no information" rather than as an error.
 */
export const NET_FAILURE_KINDS = [
  /** Consent was never granted, or has been switched off. No socket was opened. */
  'declined',
  /** The scope was cancelled — usually because the operator closed the deck. */
  'cancelled',
  /** DNS or connect failed. Almost always no network rather than a bad service. */
  'offline',
  /** The deadline passed, or the transfer stopped producing bytes. */
  'timeout',
  /** The service asked us to slow down, and kept asking past our retry budget. */
  'rate-limited',
  /** 5xx, and still 5xx after the retries. */
  'unavailable',
  /** The service answered, and has nothing for this query. */
  'not-found',
  /** A 4xx we cannot fix by retrying. A bug on our side until proven otherwise. */
  'rejected',
  /** A 2xx whose body was not what the caller was parsing for. */
  'malformed'
] as const

export type NetFailureKind = (typeof NET_FAILURE_KINDS)[number]

/**
 * A failure, phrased for a person.
 *
 * `message` is safe to display: like `IpcErrorPayload` it never carries a stack
 * or a path, and unlike a thrown error it also never carries the request URL —
 * which is the one place an artist's name would end up somewhere it was not
 * asked to be.
 */
export interface NetFailure {
  readonly kind: NetFailureKind
  readonly message: string
  /** The HTTP status, when there was one. For logs and bug reports, not for UI. */
  readonly status?: number
  /**
   * What the service asked us to wait, in seconds, when it said so.
   *
   * Present only on `rate-limited`, and only when `Retry-After` was parseable.
   * A pane may use it to say "try again in a minute" instead of "try again".
   */
  readonly retryAfterSeconds?: number
}

/** Every outbound operation answers with one of these. Nothing throws. */
export type NetResult<T> = { ok: true; value: T } | { ok: false; failure: NetFailure }

export function netOk<T>(value: T): NetResult<T> {
  return { ok: true, value }
}

export function netFailed<T>(failure: NetFailure): NetResult<T> {
  return { ok: false, failure }
}

/**
 * A cancellable unit of interest.
 *
 * Fetching is scoped to something the operator has open, so that closing it
 * stops the work rather than merely ignoring it — the second half of why D14
 * confines fetching to an open drawer, the first being that a shuffle-heavy
 * session must not be able to saturate MusicBrainz (**R5**).
 *
 * A union rather than a free string so that a scope which no host cancels is a
 * compile error rather than a leak nobody notices.
 */
export const NET_SCOPES = [
  'tunedeck',
  /**
   * The outbox drain (**D19**). Not a drawer, but the same unit of interest:
   * quitting, signing out or losing the network should abandon the batch in
   * flight rather than let it land against a target the operator has just
   * disconnected. The rows survive — persist first, submit second — so an
   * abandoned drain costs a retry, never a scrobble.
   */
  'scrobble'
] as const

export type NetScope = (typeof NET_SCOPES)[number]

export interface CancelNetScopeRequest {
  scope: NetScope
}

export interface CancelNetScopeResult {
  /** How many requests were abandoned. In-flight and still-queued both count. */
  cancelled: number
}
