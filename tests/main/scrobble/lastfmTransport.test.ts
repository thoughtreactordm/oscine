/**
 * The transport: what it puts on the wire, and how Last.fm's numbered errors
 * become failures the rest of Oscine already knows how to render.
 *
 * The `NetClient` is injected, so nothing here opens a socket and nothing here
 * is testing W7's client a second time. What it *is* testing is the two things
 * this file adds on top of it — the signed query string, and the error envelope
 * that arrives with a 403 or, occasionally, with a 200.
 */

import { describe, expect, it, vi } from 'vitest'
import { netFailed, netOk, type NetResult } from '../../../src/shared/net'
import type { NetClient, NetGetRequest, NetPostRequest } from '../../../src/main/net/client'
import {
  createLastfmTransport,
  LASTFM_API_ROOT,
  LASTFM_ERROR
} from '../../../src/main/scrobble/lastfm/transport'

/** A client that answers with whatever the test scripted, and records the ask. */
function fakeClient(
  ...answers: NetResult<unknown>[]
): NetClient & { seen: NetGetRequest[]; posted: NetPostRequest[] } {
  const seen: NetGetRequest[] = []
  const posted: NetPostRequest[] = []
  const next = (request: NetGetRequest): Promise<never> => {
    seen.push(request)
    return Promise.resolve(answers.shift() ?? netOk({})) as Promise<never>
  }
  return {
    seen,
    posted,
    getText: next,
    getBytes: next,
    getJson: next,
    postJson: (request: NetPostRequest): Promise<never> => {
      posted.push(request)
      return next(request)
    }
  }
}

const options = (client: NetClient) => ({
  limiter: { acquire: vi.fn() } as never,
  scopes: { enter: vi.fn(), cancel: vi.fn(), size: vi.fn() } as never,
  sharedSecret: () => 'sharedsecret',
  client
})

describe('createLastfmTransport', () => {
  it('signs the call, asks for JSON, and enrols in the scrobble scope', async () => {
    const client = fakeClient(netOk({ token: 'abc' }))
    await createLastfmTransport(options(client)).call({
      method: 'auth.getToken',
      api_key: 'key'
    })

    const [request] = client.seen
    const url = new URL(request.url)
    expect(`${url.origin}${url.pathname}`).toBe(LASTFM_API_ROOT)
    expect(url.searchParams.get('method')).toBe('auth.getToken')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('api_sig')).toMatch(/^[0-9a-f]{32}$/)
    expect(request.scope).toBe('scrobble')
  })

  it('asks the client to read Last.fm’s error statuses as answers', async () => {
    const client = fakeClient(netOk({}))
    await createLastfmTransport(options(client)).call({ method: 'auth.getToken' })
    // Without this the 403 that carries error 14 arrives as a bare `rejected`
    // and the auth flow cannot tell "not approved yet" from "bad key".
    expect(client.seen[0].acceptStatuses).toContain(403)
    // And not 404: a missing endpoint is a Oscine bug, not a message.
    expect(client.seen[0].acceptStatuses).not.toContain(404)
  })

  it('resolves the shared secret per call, so an override takes effect live', async () => {
    let secret = 'first'
    const client = fakeClient(netOk({}), netOk({}))
    const transport = createLastfmTransport({ ...options(client), sharedSecret: () => secret })

    await transport.call({ method: 'auth.getToken' })
    secret = 'second'
    await transport.call({ method: 'auth.getToken' })

    const sig = (index: number) => new URL(client.seen[index].url).searchParams.get('api_sig')
    expect(sig(0)).not.toBe(sig(1))
  })

  it('returns the body when the call succeeded', async () => {
    const client = fakeClient(netOk({ token: 'abc' }))
    const result = await createLastfmTransport(options(client)).call<{ token: string }>({
      method: 'auth.getToken'
    })
    expect(result).toEqual({ ok: true, value: { token: 'abc' } })
  })

  it('reads an error envelope that arrived with a 200', async () => {
    // Last.fm has been seen to do this, and a caller that trusted the status
    // would report "unreadable" for a perfectly clear error 14.
    const client = fakeClient(netOk({ error: 14, message: 'Unauthorized Token' }))
    const result = await createLastfmTransport(options(client)).call({ method: 'auth.getSession' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe(LASTFM_ERROR.unauthorizedToken)
  })

  it('passes a transport failure through with no code', async () => {
    const client = fakeClient(netFailed({ kind: 'offline', message: 'no' }))
    const result = await createLastfmTransport(options(client)).call({ method: 'auth.getToken' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBeNull()
    expect(result.ok === false && result.failure.kind).toBe('offline')
  })

  describe('the error taxonomy', () => {
    const kindFor = async (code: number, message = ''): Promise<string> => {
      const client = fakeClient(netOk({ error: code, message }))
      const result = await createLastfmTransport(options(client)).call({ method: 'x' })
      return result.ok ? 'ok' : result.failure.kind
    }

    it('maps the transient codes to unavailable, so the outbox backs off', async () => {
      expect(await kindFor(LASTFM_ERROR.operationFailed)).toBe('unavailable')
      expect(await kindFor(LASTFM_ERROR.serviceOffline)).toBe('unavailable')
      expect(await kindFor(LASTFM_ERROR.temporarilyUnavailable)).toBe('unavailable')
    })

    it('maps the rate limit to rate-limited', async () => {
      expect(await kindFor(LASTFM_ERROR.rateLimitExceeded)).toBe('rate-limited')
    })

    it('maps an invalid session key to rejected, and says to reconnect', async () => {
      const client = fakeClient(netOk({ error: LASTFM_ERROR.invalidSessionKey }))
      const result = await createLastfmTransport(options(client)).call({ method: 'x' })
      expect(result.ok === false && result.failure.kind).toBe('rejected')
      expect(result.ok === false && result.failure.message).toMatch(/reconnect/i)
    })

    it('names the API key when it is the API key', async () => {
      const client = fakeClient(netOk({ error: LASTFM_ERROR.invalidApiKey }))
      const result = await createLastfmTransport(options(client)).call({ method: 'x' })
      expect(result.ok === false && result.failure.message).toMatch(/API key/)
    })

    it('keeps Last.fm’s own words for a code it does not know', async () => {
      const client = fakeClient(netOk({ error: 42, message: 'Something specific happened' }))
      const result = await createLastfmTransport(options(client)).call({ method: 'x' })
      expect(result.ok === false && result.failure.message).toBe('Something specific happened')
    })

    it('handles an envelope whose error is not a number', async () => {
      const client = fakeClient(netOk({ error: 'boom' }))
      const result = await createLastfmTransport(options(client)).call({ method: 'x' })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.code).toBeNull()
    })
  })
})

describe('post', () => {
  it('signs the same way but puts the parameters in a body', async () => {
    const client = fakeClient(netOk({ scrobbles: {} }))
    await createLastfmTransport(options(client)).post({
      method: 'track.scrobble',
      sk: 'session-key',
      'artist[0]': 'Talk Talk'
    })

    const [request] = client.posted
    expect(request.url).toBe(LASTFM_API_ROOT)
    expect(request.form.get('method')).toBe('track.scrobble')
    expect(request.form.get('api_sig')).toMatch(/^[0-9a-f]{32}$/)
    expect(request.form.get('format')).toBe('json')
    expect(request.scope).toBe('scrobble')
    // The session key belongs in a body, not in a URL that proxies and access
    // logs write down.
    expect(request.url).not.toContain('session-key')
  })

  it('asks for a single attempt, because the outbox is the retry', async () => {
    const client = fakeClient(netOk({}))
    await createLastfmTransport(options(client)).post({ method: 'track.scrobble' })

    // A POST that fails after Last.fm recorded it is indistinguishable from one
    // that never arrived. W11-2's queue reschedules on a durable row instead.
    expect(client.posted[0].maxAttempts).toBe(1)
  })

  it('reads the error envelope exactly as the GET path does', async () => {
    const client = fakeClient(netOk({ error: LASTFM_ERROR.invalidSessionKey, message: 'dead' }))
    const result = await createLastfmTransport(options(client)).post({ method: 'track.scrobble' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(LASTFM_ERROR.invalidSessionKey)
    expect(result.failure.kind).toBe('rejected')
  })
})
