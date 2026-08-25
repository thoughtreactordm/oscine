import { describe, expect, it, vi } from 'vitest'
import type { NetFailure, NetFailureKind, NetResult } from '@shared/net'
import { createNetClient, parseRetryAfter } from '../../../src/main/net/client'
import type { NetworkConsent } from '../../../src/main/net/consent'
import type { RateLimiter } from '../../../src/main/net/rateLimiter'
import { createScopeRegistry } from '../../../src/main/net/scopes'

/** A limiter that never delays, so the client's own logic is what is measured. */
function openLimiter(): RateLimiter & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    acquire(host, signal) {
      calls.push(host)
      if (signal?.aborted) return Promise.reject(signal.reason)
      return Promise.resolve()
    },
    waiting: () => 0
  }
}

function consentOf(granted: boolean | (() => boolean)): NetworkConsent {
  return { granted: typeof granted === 'function' ? granted : () => granted }
}

function reply(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init)
}

interface ClientHarness {
  fetchImpl: ReturnType<typeof vi.fn>
  limiter: ReturnType<typeof openLimiter>
  scopes: ReturnType<typeof createScopeRegistry>
  slept: number[]
}

function harness(
  responses: Array<Response | Error | (() => Response | Promise<Response>)>,
  options: { consent?: NetworkConsent; maxAttempts?: number } = {}
) {
  const limiter = openLimiter()
  const scopes = createScopeRegistry()
  const slept: number[] = []
  let index = 0

  const fetchImpl = vi.fn(async () => {
    const next = responses[Math.min(index++, responses.length - 1)]
    if (typeof next === 'function') return next()
    if (next instanceof Error) throw next
    return next
  })

  const client = createNetClient({
    consent: options.consent ?? consentOf(true),
    limiter,
    scopes,
    maxAttempts: options.maxAttempts ?? 3,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // Backoff is exercised by recording it rather than by waiting for it.
    sleep: async (ms) => {
      slept.push(ms)
    }
  })

  const state: ClientHarness = { fetchImpl, limiter, scopes, slept }
  return { client, ...state }
}

const URL_UNDER_TEST = 'https://musicbrainz.org/ws/2/artist?query=nirvana'

/** Narrows to the failure, so a test that accidentally succeeded fails loudly. */
function failed(result: NetResult<unknown>): NetFailure {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`)
  return result.failure
}

describe('consent, before anything else', () => {
  /**
   * The acceptance criterion that matters for W7-6: with consent withheld, no
   * socket is opened. Asserted against the injected `fetch` rather than against
   * a packet capture, which is the closest a unit test gets — the capture is
   * the manual half of the card.
   */
  it('opens no socket when consent is withheld', async () => {
    const { client, fetchImpl, limiter } = harness([reply('{}')], {
      consent: consentOf(false)
    })

    const result = await client.getJson({ url: URL_UNDER_TEST, scope: 'tunedeck' })

    expect(result.ok).toBe(false)
    expect(failed(result).kind).toBe('declined')
    expect(fetchImpl).not.toHaveBeenCalled()
    // Nor does it take a rate-limit slot on the way to being refused.
    expect(limiter.calls).toEqual([])
  })

  it('abandons a retry when consent is withdrawn mid-flight', async () => {
    let allowed = true
    const { client, fetchImpl } = harness([reply('', { status: 503 })], {
      consent: consentOf(() => allowed)
    })

    // The first attempt fails retryably; the toggle goes off before the second.
    fetchImpl.mockImplementationOnce(async () => {
      allowed = false
      return reply('', { status: 503 })
    })

    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })

    expect(failed(result).kind).toBe('declined')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('a successful request', () => {
  it('returns the body, and identifies itself', async () => {
    const { client, fetchImpl, limiter } = harness([reply('{"artists":[]}')])

    const result = await client.getJson<{ artists: unknown[] }>({
      url: URL_UNDER_TEST,
      scope: 'tunedeck'
    })

    expect(result).toEqual({ ok: true, value: { artists: [] } })
    expect(limiter.calls).toEqual(['musicbrainz.org'])

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    // MusicBrainz requires an identifying agent; a version-less or absent one
    // is what gets a client blocked.
    expect(headers['user-agent']).toMatch(/^Oscine\/\d+\.\d+\.\d+ /)
    expect(headers.accept).toBe('application/json')
  })

  it('reports a body that is not JSON as malformed rather than throwing', async () => {
    const { client } = harness([reply('<html>maintenance</html>')])
    const result = await client.getJson({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(failed(result).kind).toBe('malformed')
  })
})

describe('every failure mode is a value', () => {
  const cases: Array<{ name: string; response: Response | Error; kind: NetFailureKind }> = [
    { name: '404', response: reply('', { status: 404 }), kind: 'not-found' },
    { name: '410', response: reply('', { status: 410 }), kind: 'not-found' },
    { name: '400', response: reply('', { status: 400 }), kind: 'rejected' },
    { name: '403', response: reply('', { status: 403 }), kind: 'rejected' },
    { name: '503', response: reply('', { status: 503 }), kind: 'unavailable' },
    { name: '500', response: reply('', { status: 500 }), kind: 'unavailable' },
    { name: '429', response: reply('', { status: 429 }), kind: 'rate-limited' },
    { name: '408', response: reply('', { status: 408 }), kind: 'timeout' },
    { name: 'a connect failure', response: new TypeError('fetch failed'), kind: 'offline' }
  ]

  for (const { name, response, kind } of cases) {
    it(`turns ${name} into a ${kind} state`, async () => {
      const { client } = harness([response])
      const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })

      expect(result.ok).toBe(false)
      expect(failed(result).kind).toBe(kind)
      // Nothing anywhere on this path is allowed to throw into a caller.
      expect(result).toHaveProperty('failure.message')
    })
  }

  it('refuses an unusable URL without reaching the limiter', async () => {
    const { client, limiter, fetchImpl } = harness([reply('{}')])
    const result = await client.getText({ url: 'not a url', scope: 'tunedeck' })

    expect(failed(result).kind).toBe('rejected')
    expect(limiter.calls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

/**
 * The one status class a caller may reclassify, and the three it may not.
 *
 * Added for W11-3: Last.fm answers `auth.getSession` with a 403 whose body says
 * *which* error occurred, and "the operator has not clicked Allow yet" and "that
 * API key is not valid" are a wait and a stop respectively. Without the body
 * they are one `rejected` with a 403 on it.
 */
describe('acceptStatuses', () => {
  it('reads a listed status as an answer instead of a refusal', async () => {
    const { client } = harness([reply('{"error":14}', { status: 403 })])
    const result = await client.getJson<{ error: number }>({
      url: URL_UNDER_TEST,
      scope: 'scrobble',
      acceptStatuses: [403]
    })

    expect(result).toEqual({ ok: true, value: { error: 14 } })
  })

  it('reads more than one listed status, which is why it is a list', async () => {
    // Last.fm answers error 14 with 403 and error 13 with 400 — measured, not
    // assumed. A caller that listed only the status it happened to see first
    // would lose the other one to a bare `rejected`.
    const { client } = harness([reply('{"error":13}', { status: 400 })])
    const result = await client.getJson<{ error: number }>({
      url: URL_UNDER_TEST,
      scope: 'scrobble',
      acceptStatuses: [400, 401, 403]
    })

    expect(result).toEqual({ ok: true, value: { error: 13 } })
  })

  it('leaves an unlisted status alone', async () => {
    const { client } = harness([reply('{"error":14}', { status: 403 })])
    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'scrobble' })

    expect(failed(result).kind).toBe('rejected')
  })

  it('cannot be used to opt out of backoff', async () => {
    // 429, 408 and 5xx are classified before this is consulted, so listing one
    // buys a retry rather than a body — which is the correct answer and worth
    // pinning, because the alternative is a caller silently disabling the retry
    // ladder for a whole host by adding a number to an array.
    const { client, fetchImpl, slept } = harness([
      reply('{"error":29}', { status: 429 }),
      reply('{"ok":true}', { status: 200 })
    ])
    const result = await client.getJson<{ ok: boolean }>({
      url: URL_UNDER_TEST,
      scope: 'scrobble',
      acceptStatuses: [429, 503]
    })

    expect(result).toEqual({ ok: true, value: { ok: true } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(slept).toEqual([500])
  })

  it('still refuses to open a socket without consent', async () => {
    const { client, fetchImpl } = harness([reply('{"error":14}', { status: 403 })], {
      consent: consentOf(false)
    })
    const result = await client.getJson({
      url: URL_UNDER_TEST,
      scope: 'scrobble',
      acceptStatuses: [403]
    })

    expect(failed(result).kind).toBe('declined')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('retrying', () => {
  it('retries a 503 and succeeds, with backoff between attempts', async () => {
    const { client, fetchImpl, slept } = harness([
      reply('', { status: 503 }),
      reply('', { status: 503 }),
      reply('ok')
    ])

    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })

    expect(result).toEqual({ ok: true, value: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(slept).toEqual([500, 1_000])
  })

  it('stops at the attempt budget and reports the last failure', async () => {
    const { client, fetchImpl } = harness([reply('', { status: 503 })], { maxAttempts: 3 })

    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })

    expect(failed(result).kind).toBe('unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 404', async () => {
    const { client, fetchImpl } = harness([reply('', { status: 404 })])
    await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 400', async () => {
    const { client, fetchImpl } = harness([reply('', { status: 400 })])
    await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('honours a Retry-After that is short enough to wait for', async () => {
    const { client, slept } = harness([
      reply('', { status: 429, headers: { 'retry-after': '2' } }),
      reply('ok')
    ])

    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })

    expect(result).toEqual({ ok: true, value: 'ok' })
    expect(slept).toEqual([2_000])
  })

  it('gives up rather than waiting out a long Retry-After', async () => {
    const { client, fetchImpl, slept } = harness([
      reply('', { status: 429, headers: { 'retry-after': '120' } }),
      reply('ok')
    ])

    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })

    expect(failed(result).kind).toBe('rate-limited')
    expect(failed(result).retryAfterSeconds).toBe(120)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })
})

describe('cancellation', () => {
  it('reports a cancelled scope as cancelled, not as an error', async () => {
    const { client, scopes } = harness([
      () => {
        // The scope closes while the request is in flight.
        scopes.cancel('tunedeck')
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      }
    ])

    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(failed(result).kind).toBe('cancelled')
  })

  it('does not retry after a cancelled scope', async () => {
    const { client, scopes, fetchImpl } = harness([
      () => {
        scopes.cancel('tunedeck')
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      },
      reply('ok')
    ])

    await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('leaves the scope empty once a request finishes', async () => {
    const { client, scopes } = harness([reply('ok')])
    await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(scopes.size('tunedeck')).toBe(0)
  })

  it('leaves the scope empty when a request fails', async () => {
    const { client, scopes } = harness([reply('', { status: 400 })])
    await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(scopes.size('tunedeck')).toBe(0)
  })

  /**
   * The half of cancellation that is easy to get wrong: work still queued
   * behind the rate limiter must be dropped without ever reaching the socket.
   * A layer that only aborted in-flight requests would still send the other
   * nineteen of a twenty-artist burst, one per second, to a deck nobody has
   * open.
   */
  it('never opens a socket for a request cancelled while waiting for a slot', async () => {
    const scopes = createScopeRegistry()
    const fetchImpl = vi.fn(async () => reply('ok'))
    let reachedLimiter = false

    const client = createNetClient({
      consent: consentOf(true),
      limiter: {
        // A slot that never arrives: only the abort can settle this.
        acquire: (_host, signal) =>
          new Promise((_resolve, reject) => {
            reachedLimiter = true
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
        waiting: () => 1
      },
      scopes,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const pending = client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    await Promise.resolve()
    expect(reachedLimiter).toBe(true)
    expect(scopes.size('tunedeck')).toBe(1)

    expect(scopes.cancel('tunedeck')).toBe(1)

    expect(failed(await pending).kind).toBe('cancelled')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(scopes.size('tunedeck')).toBe(0)
  })

  /**
   * Open, close, open — the cycle W7-7's acceptance names. The second open must
   * find nothing of the first still enrolled, and must be free to work.
   */
  it('leaves nothing behind for the next open to wait on', async () => {
    const { client, scopes, fetchImpl } = harness([reply('ok')])

    const stalled = scopes.enter('tunedeck')
    expect(scopes.cancel('tunedeck')).toBe(1)
    stalled.release()
    expect(scopes.size('tunedeck')).toBe(0)

    const result = await client.getText({ url: URL_UNDER_TEST, scope: 'tunedeck' })
    expect(result).toEqual({ ok: true, value: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(scopes.size('tunedeck')).toBe(0)
  })
})

describe('parseRetryAfter', () => {
  it('reads a count of seconds', () => {
    expect(parseRetryAfter('30', 0)).toBe(30)
  })

  it('reads an HTTP date, relative to now', () => {
    const now = Date.parse('2026-08-02T12:00:00Z')
    expect(parseRetryAfter('Sun, 02 Aug 2026 12:00:30 GMT', now)).toBe(30)
  })

  it('never returns a negative wait', () => {
    const now = Date.parse('2026-08-02T12:00:00Z')
    expect(parseRetryAfter('Sun, 02 Aug 2026 11:59:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('-5', 0)).toBe(0)
  })

  it('yields null for an absent or unreadable header', () => {
    expect(parseRetryAfter(null, 0)).toBeNull()
    expect(parseRetryAfter('', 0)).toBeNull()
    expect(parseRetryAfter('soon', 0)).toBeNull()
  })
})

describe('postJson', () => {
  /**
   * The pipeline is shared with `getJson` and tested there. What is asserted
   * here is only what POST adds: the method, the body, the content type, and
   * the per-request attempt budget that D19's outbox needs in order to own its
   * own retries.
   */
  const form = (): URLSearchParams => new URLSearchParams({ method: 'track.scrobble', sk: 'abc' })

  it('sends the form as a body, not as a query string', async () => {
    const { client, fetchImpl } = harness([reply('{"ok":1}')])
    const result = await client.postJson({ url: URL_UNDER_TEST, scope: 'scrobble', form: form() })

    expect(result).toEqual({ ok: true, value: { ok: 1 } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('method=track.scrobble&sk=abc')
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded'
    )
    // The session key is in the body precisely so it is not here.
    expect(url).not.toContain('sk=')
  })

  it('honours a per-request attempt budget, so a caller can own its retries', async () => {
    const { client, fetchImpl, slept } = harness([reply('nope', { status: 503 })])
    const result = await client.postJson({
      url: URL_UNDER_TEST,
      scope: 'scrobble',
      form: form(),
      maxAttempts: 1
    })

    // One 503, one attempt, no wait: a scrobble that may already have landed is
    // not sent again on a guess. The outbox reschedules it instead.
    expect(failed(result).kind).toBe('unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('still retries when the caller does not ask it not to', async () => {
    const { client, fetchImpl } = harness([reply('x', { status: 503 }), reply('{"ok":1}')])
    const result = await client.postJson({ url: URL_UNDER_TEST, scope: 'scrobble', form: form() })

    expect(result).toEqual({ ok: true, value: { ok: 1 } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('is still refused without consent, and still opens no socket', async () => {
    const { client, fetchImpl } = harness([reply('{}')], { consent: consentOf(false) })
    const result = await client.postJson({ url: URL_UNDER_TEST, scope: 'scrobble', form: form() })

    expect(failed(result).kind).toBe('declined')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads a listed error status as an answer, as the GET path does', async () => {
    const { client } = harness([
      reply('{"error":9,"message":"Invalid session key"}', { status: 403 })
    ])
    const result = await client.postJson({
      url: URL_UNDER_TEST,
      scope: 'scrobble',
      form: form(),
      acceptStatuses: [403]
    })

    expect(result).toEqual({ ok: true, value: { error: 9, message: 'Invalid session key' } })
  })
})
