/**
 * The only place in Oscine that opens a socket on Oscine's own initiative.
 *
 * Four things wrap every request, in this order, and the order is the design:
 *
 * 1. **Consent** (D14). Checked before anything else, so a refusal costs no
 *    socket, no queue slot and no timer — and rechecked before each retry, so
 *    switching the toggle off abandons a backoff already scheduled.
 * 2. **Rate limit** (R5). Per host, before the request leaves. Waiting here is
 *    cancellable, which is what makes closing the deck cheap.
 * 3. **Deadline**. Per attempt, covering the body read as well as the reply, so
 *    a host that sends headers and then goes quiet is not waited on forever.
 * 4. **Retry**. Bounded, backed off, and only for the failures a retry can
 *    actually fix.
 *
 * ## Nothing throws
 *
 * Every path returns a `NetResult`. W7-7's acceptance says every failure mode
 * must surface as a state the UI can render rather than as an exception thrown
 * into a component, and the way to guarantee that is for the exception never to
 * exist — not for each caller to remember a `try`. The one thing that can still
 * throw is a bug in this file, and that is what `internal` is for at the IPC
 * layer above.
 *
 * ## What a retry is for
 *
 * 429, 408 and 5xx say "not now"; a connect failure says "the network blinked".
 * Those are worth one more go. A 404 is an *answer* — R5's unmatchable artists
 * are the common case, not an error — and every other 4xx is a request this
 * build is getting wrong, which retrying turns from one bad request into three.
 */

import { netFailed, netOk, type NetFailure, type NetResult, type NetScope } from '@shared/net'
import type { NetworkConsent } from './consent'
import { readCappedBytes, readCappedText, ResponseTooLargeError } from './http'
import type { RateLimiter } from './rateLimiter'
import { RequestTimeoutError, ScopeCancelledError, type ScopeRegistry } from './scopes'
import { OSCINE_USER_AGENT } from './userAgent'

/** One attempt's deadline, covering the reply and the body read together. */
const DEFAULT_TIMEOUT_MS = 10_000

/** Three attempts is two retries: enough for a blink, short of a pile-on. */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * A metadata reply that needs a megabyte is not a metadata reply.
 *
 * Generous against MusicBrainz's largest artist documents and small enough that
 * a host answering with something else entirely is cut off rather than buffered.
 */
const DEFAULT_MAX_BYTES = 1_048_576

/**
 * How long a `Retry-After` may ask us to wait before we stop waiting.
 *
 * A service that wants two minutes is entitled to them, but not while somebody
 * is looking at a spinner. Past this we give up and say `rate-limited`, with the
 * number the service asked for, so the pane can offer to try again later rather
 * than pretend to be loading.
 */
const DEFAULT_RETRY_AFTER_CEILING_MS = 15_000

export interface NetGetRequest {
  url: string
  scope: NetScope
  /** Sent as `Accept`. Defaults to `application/json` for `getJson`, anything for text. */
  accept?: string
  /**
   * Extra request headers, for the one caller whose auth is a header rather than
   * a query or form field — W11-8's ListenBrainz, which carries its user token in
   * `Authorization: Token <token>`.
   *
   * Merged *under* the fixed `accept`, `user-agent` and (on a POST) `content-type`,
   * so a caller cannot quietly reshape the request's identity or its body's type:
   * those three are the client's to set and are spread last. Everything else a
   * caller adds — an `Authorization`, an API-versioning header — passes through.
   */
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxBytes?: number
  /**
   * Statuses whose body is an *answer* rather than a refusal, and should be read
   * and returned like a 200.
   *
   * Empty by default, because for a well-behaved API a 4xx means the request was
   * wrong and its body is a stack trace at best. Last.fm is the exception this
   * exists for (W11-3): it answers `auth.getSession` with `403` and a document
   * saying *which* of its numbered errors occurred, and the difference between
   * error 14 ("the operator has not clicked Allow yet", keep waiting) and error
   * 10 ("that API key is not valid", stop) is the entire state machine of the
   * desktop auth flow. Discarding the body would leave both looking like one
   * `rejected` with a 403 on it.
   *
   * It changes what counts as an answer and nothing else. Consent, the limiter,
   * the deadline and the retry ladder are all upstream and untouched — in
   * particular 429, 408 and 5xx are still classified before this is consulted,
   * so a caller cannot accidentally opt out of backoff by listing one of them.
   */
  acceptStatuses?: readonly number[]
  /**
   * How many attempts this request gets, overriding the client's ladder.
   *
   * Exists for callers that already have a durable retry of their own and would
   * rather this one stayed out of the way. D19's outbox is the case: a scrobble
   * batch that comes back 503 is rescheduled on a persistent row with its own
   * backoff, so retrying inside the client buys nothing and costs the one thing
   * a queue cannot take back — a second delivery of a request that may well have
   * landed the first time. `1` means "attempt it once and tell me".
   */
  maxAttempts?: number
}

/**
 * A POST, which is every rule above with a body attached.
 *
 * `form` **xor** `json`, and exactly one of them: the two verbs Oscine posts
 * with are Last.fm's `application/x-www-form-urlencoded` writes and W11-8's
 * ListenBrainz `application/json` submits, and each names its own content type so
 * a caller never sets one by hand. This is the widening the earlier version of
 * this comment promised rather than took in advance — still not a free `body`
 * plus a `content-type`, because those two are the two shapes that exist and a
 * general body parameter would be a third thing to validate for a case that does
 * not. `json` is serialised with `JSON.stringify`, so `undefined` is the "no JSON
 * body" signal and the form branch is taken; a caller posting an empty body sends
 * an empty `form`.
 */
export interface NetPostRequest extends NetGetRequest {
  form?: URLSearchParams
  json?: unknown
}

/** A request body reduced to the two things the socket needs. */
interface PreparedBody {
  readonly contentType: string
  readonly text: string
}

export interface NetClient {
  getText(request: NetGetRequest): Promise<NetResult<string>>
  getJson<T>(request: NetGetRequest): Promise<NetResult<T>>
  /**
   * A signed write, as JSON.
   *
   * POST exists here for two reasons and neither is style. A `track.scrobble` of
   * fifty listens is upwards of three hundred parameters, which is past what a
   * query string can be relied on to carry — and the session key would be *in*
   * that query string, where proxies, access logs and browser history all keep
   * things that a request body is not asked to survive.
   *
   * Everything upstream of the socket is shared with `getJson`: consent, the
   * per-host limiter, the deadline, the status mapping and the scope. What is
   * different is the method, the body and the one caveat below.
   *
   * **Retries are not idempotent here.** A POST that fails after the server has
   * acted is indistinguishable from one that never arrived, so a caller whose
   * request has side effects should pass `maxAttempts: 1` and own the retry
   * itself. This client will not guess.
   */
  postJson<T>(request: NetPostRequest): Promise<NetResult<T>>
  /**
   * The same request, kept as bytes.
   *
   * Every rule above applies unchanged — this is the reader at the end of the
   * pipeline swapped, not a second path to a socket. W7-13's artist photograph
   * is the only caller: it arrives from Commons as an image and is handed
   * straight to the artwork processor, so decoding it as UTF-8 on the way
   * through would be a corruption rather than a conversion.
   *
   * `maxBytes` matters more here than for the two above. The default ceiling is
   * sized for a metadata document; an image needs its own, and a caller that
   * forgets gets a `malformed` rather than a surprise.
   */
  getBytes(request: NetGetRequest): Promise<NetResult<Uint8Array>>
}

export interface NetClientOptions {
  consent: NetworkConsent
  limiter: RateLimiter
  scopes: ScopeRegistry
  /** Injected so tests never touch a socket. */
  fetchImpl?: typeof fetch
  userAgent?: string
  maxAttempts?: number
  timeoutMs?: number
  maxBytes?: number
  retryAfterCeilingMs?: number
  /** Milliseconds to wait before attempt `attempt + 1`. 1-based. */
  backoffMs?: (attempt: number) => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * 500ms then 1s. No jitter: jitter exists to decorrelate a fleet, and there is
 * exactly one Oscine behind a limiter that already serialises per host.
 */
function defaultBackoff(attempt: number): number {
  return 500 * 2 ** (attempt - 1)
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    ;(timer as { unref?: () => void }).unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms)
  ;(handle as { unref?: () => void }).unref?.()
  return handle
}

const DECLINED: NetFailure = {
  kind: 'declined',
  message: 'Online lookups are off. Turn them on in Settings › Network.'
}

/**
 * Seconds from a `Retry-After`, which may be a count or an HTTP date.
 *
 * A date in the past yields 0 rather than a negative wait, and anything
 * unparseable yields `null` so the caller falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)

  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, (at - now) / 1000)
}

/** What one attempt concluded: an answer, or a reason with a verdict on retrying. */
type Attempt<T> =
  | { outcome: 'ok'; body: T }
  | { outcome: 'give-up'; failure: NetFailure }
  | { outcome: 'retry'; failure: NetFailure; afterMs: number | null }

/**
 * How an accepted response becomes a value.
 *
 * The one thing that differs between `getText` and `getBytes`, and it is
 * deliberately the *last* thing: consent, the limiter, the deadline, the status
 * mapping and the retry ladder are all upstream of it and identical for both. A
 * second `get*` that reimplemented any of those would be a second set of rules
 * to keep in step with these.
 */
type BodyReader<T> = (response: Response, maxBytes: number) => Promise<T>

/**
 * Map an abort reason onto a failure.
 *
 * A cancelled scope and an elapsed deadline arrive by the same mechanism and
 * mean opposite things to a pane, which is why `scopes.ts` gives them distinct
 * reason types instead of a bare `DOMException`.
 */
function fromAbort(reason: unknown): NetFailure {
  if (reason instanceof ScopeCancelledError) {
    return { kind: 'cancelled', message: 'The request was cancelled.' }
  }
  if (reason instanceof RequestTimeoutError) {
    return { kind: 'timeout', message: 'The service did not reply in time.' }
  }
  // Anything else aborted this request without going through the registry,
  // which is a bug here rather than a state to render.
  return { kind: 'cancelled', message: 'The request was cancelled.' }
}

export function createNetClient({
  consent,
  limiter,
  scopes,
  fetchImpl = fetch,
  userAgent = OSCINE_USER_AGENT,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes: defaultMaxBytes = DEFAULT_MAX_BYTES,
  retryAfterCeilingMs = DEFAULT_RETRY_AFTER_CEILING_MS,
  backoffMs = defaultBackoff,
  sleep = defaultSleep,
  setTimer = defaultSetTimer,
  clearTimer = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}: NetClientOptions): NetClient {
  async function attemptOnce<T>(
    request: NetGetRequest,
    host: string,
    accept: string,
    scopeSignal: AbortSignal,
    read: BodyReader<T>,
    body: PreparedBody | undefined
  ): Promise<Attempt<T>> {
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs
    const maxBytes = request.maxBytes ?? defaultMaxBytes

    // Per attempt rather than per request, so a deadline that fires does not
    // also poison the retry. The scope is forwarded rather than combined, which
    // keeps `reason` the *original* error object and not a re-wrapped copy.
    const attempt = new AbortController()
    const forward = (): void => attempt.abort(scopeSignal.reason)
    if (scopeSignal.aborted) forward()
    else scopeSignal.addEventListener('abort', forward, { once: true })

    let timer: unknown = null
    const disarm = (): void => {
      if (timer !== null) clearTimer(timer)
      timer = null
      scopeSignal.removeEventListener('abort', forward)
    }

    try {
      await limiter.acquire(host, attempt.signal)
    } catch {
      disarm()
      return { outcome: 'give-up', failure: fromAbort(attempt.signal.reason) }
    }

    timer = setTimer(() => attempt.abort(new RequestTimeoutError(timeoutMs)), timeoutMs)

    let response: Response
    try {
      response = await fetchImpl(request.url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'follow',
        signal: attempt.signal,
        // Caller headers first, the client's own last: `accept`, `user-agent` and
        // the body's `content-type` are the client's to set and win any collision,
        // so an `Authorization` passes through but the request's identity does not
        // become a caller's to forge.
        headers: {
          ...request.headers,
          accept,
          'user-agent': userAgent,
          ...(body === undefined ? {} : { 'content-type': body.contentType })
        },
        ...(body === undefined ? {} : { body: body.text })
      })
    } catch {
      const aborted = attempt.signal.aborted
      disarm()
      if (aborted) {
        const failure = fromAbort(attempt.signal.reason)
        // A deadline is worth one more attempt; a cancelled scope never is.
        return failure.kind === 'timeout'
          ? { outcome: 'retry', failure, afterMs: null }
          : { outcome: 'give-up', failure }
      }
      return {
        outcome: 'retry',
        failure: {
          kind: 'offline',
          message: 'Could not reach the service. Check your connection.'
        },
        afterMs: null
      }
    }

    if (response.status === 429) {
      disarm()
      const seconds = parseRetryAfter(response.headers.get('retry-after'), Date.now())
      return {
        outcome: 'retry',
        failure: {
          kind: 'rate-limited',
          message: 'The service asked us to slow down.',
          status: 429,
          ...(seconds === null ? {} : { retryAfterSeconds: seconds })
        },
        afterMs: seconds === null ? null : seconds * 1000
      }
    }

    if (response.status === 408 || response.status >= 500) {
      disarm()
      return {
        outcome: 'retry',
        failure:
          response.status === 408
            ? { kind: 'timeout', message: 'The service did not reply in time.', status: 408 }
            : {
                kind: 'unavailable',
                message: 'The service is temporarily unavailable.',
                status: response.status
              },
        afterMs: null
      }
    }

    // Below the retryable classes and above the refusals: a listed status is
    // read as an answer, but a listed 500 is still a 500 and still backs off.
    const answered = response.ok || (request.acceptStatuses?.includes(response.status) ?? false)

    if (!answered && (response.status === 404 || response.status === 410)) {
      disarm()
      return {
        outcome: 'give-up',
        failure: {
          kind: 'not-found',
          message: 'The service has nothing for this.',
          status: response.status
        }
      }
    }

    if (!answered) {
      disarm()
      return {
        outcome: 'give-up',
        failure: {
          kind: 'rejected',
          message: 'The service refused the request.',
          status: response.status
        }
      }
    }

    try {
      const body = await read(response, maxBytes)
      return { outcome: 'ok', body }
    } catch (err) {
      const aborted = attempt.signal.aborted
      if (aborted) {
        const failure = fromAbort(attempt.signal.reason)
        return failure.kind === 'timeout'
          ? { outcome: 'retry', failure, afterMs: null }
          : { outcome: 'give-up', failure }
      }
      return {
        outcome: 'give-up',
        failure:
          err instanceof ResponseTooLargeError
            ? { kind: 'malformed', message: 'The reply was too large to read.' }
            : { kind: 'offline', message: 'The reply stopped part way through.' }
      }
    } finally {
      disarm()
    }
  }

  async function perform<T>(
    request: NetGetRequest,
    accept: string,
    read: BodyReader<T>,
    body?: PreparedBody
  ): Promise<NetResult<T>> {
    if (!consent.granted()) return netFailed(DECLINED)

    const attempts = request.maxAttempts ?? maxAttempts

    let host: string
    try {
      host = new URL(request.url).host
    } catch {
      return netFailed({ kind: 'rejected', message: 'That address is not usable.' })
    }

    const entry = scopes.enter(request.scope)
    try {
      for (let attempt = 1; ; attempt++) {
        // Rechecked here rather than only at the top: a retry scheduled before
        // the operator switched the toggle off must not outlive the decision.
        if (!consent.granted()) return netFailed(DECLINED)

        const result = await attemptOnce(request, host, accept, entry.signal, read, body)
        if (result.outcome === 'ok') return netOk(result.body)
        if (result.outcome === 'give-up') return netFailed(result.failure)
        if (attempt >= attempts) return netFailed(result.failure)

        const delay = result.afterMs ?? backoffMs(attempt)
        if (delay > retryAfterCeilingMs) return netFailed(result.failure)
        try {
          await sleep(delay, entry.signal)
        } catch {
          return netFailed(fromAbort(entry.signal.reason))
        }
      }
    } finally {
      entry.release()
    }
  }

  /**
   * The one place a POST's body becomes bytes, so its content type cannot drift
   * from its contents. `json` wins when present — it is `undefined` for the form
   * writes — and an absent form is an empty body rather than a thrown call.
   */
  function postBody(request: NetPostRequest): PreparedBody {
    if (request.json !== undefined) {
      return { contentType: 'application/json', text: JSON.stringify(request.json) }
    }
    return {
      contentType: 'application/x-www-form-urlencoded',
      text: (request.form ?? new URLSearchParams()).toString()
    }
  }

  /** The one place a body becomes a value, so GET and POST cannot diverge on it. */
  function asJson<T>(text: NetResult<string>): NetResult<T> {
    if (!text.ok) return text
    try {
      return netOk(JSON.parse(text.value) as T)
    } catch {
      return netFailed({ kind: 'malformed', message: 'The service sent something unreadable.' })
    }
  }

  return {
    getText: (request) => perform(request, request.accept ?? '*/*', readCappedText),

    getBytes: (request) => perform(request, request.accept ?? '*/*', readCappedBytes),

    async getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      return asJson<T>(await perform(request, request.accept ?? 'application/json', readCappedText))
    },

    async postJson<T>(request: NetPostRequest): Promise<NetResult<T>> {
      return asJson<T>(
        await perform(
          request,
          request.accept ?? 'application/json',
          readCappedText,
          postBody(request)
        )
      )
    }
  }
}
