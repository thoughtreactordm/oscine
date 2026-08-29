/**
 * The ListenBrainz transport: the token header it puts on the wire, the JSON body
 * it posts, and how an HTTP status becomes a failure the drain worker already
 * knows how to act on.
 *
 * The `NetClient` is injected, so nothing here opens a socket — this is testing
 * the two things this file adds on top of the client the widening for headers and
 * a JSON body, and the `{ code, error }` envelope that arrives with a 400 or 401.
 */

import { describe, expect, it, vi } from 'vitest'
import { netFailed, netOk, type NetResult } from '../../../src/shared/net'
import type { NetClient, NetGetRequest, NetPostRequest } from '../../../src/main/net/client'
import {
  createListenbrainzTransport,
  LISTENBRAINZ_SUBMIT_URL,
  LISTENBRAINZ_VALIDATE_URL
} from '../../../src/main/scrobble/listenbrainz/transport'
import type { ListenbrainzSubmitBody } from '../../../src/main/scrobble/listenbrainz/listens'

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
  client
})

const body: ListenbrainzSubmitBody = {
  listen_type: 'import',
  payload: [
    {
      listened_at: 1000,
      track_metadata: {
        artist_name: 'Artist',
        track_name: 'Track',
        additional_info: { media_player: 'Oscine', submission_client: 'Oscine' }
      }
    }
  ]
}

describe('createListenbrainzTransport', () => {
  describe('validateToken', () => {
    it('sends the token as an Authorization header and reads the account name', async () => {
      const client = fakeClient(netOk({ valid: true, user_name: 'operator' }))
      const result = await createListenbrainzTransport(options(client)).validateToken('tok-abc')

      const [request] = client.seen
      expect(request.url).toBe(LISTENBRAINZ_VALIDATE_URL)
      expect(request.headers?.authorization).toBe('Token tok-abc')
      expect(request.scope).toBe('scrobble')
      // 401 is read as an answer, not a refusal, so a bad token is one failure and
      // not two shapes.
      expect(request.acceptStatuses).toContain(401)
      expect(result).toEqual({ ok: true, value: { userName: 'operator' } })
    })

    it('rejects a token the service says is invalid', async () => {
      const client = fakeClient(netOk({ valid: false }))
      const result = await createListenbrainzTransport(options(client)).validateToken('nope')
      expect(result.ok === false && result.failure.kind).toBe('rejected')
    })

    it('passes a transient failure straight through', async () => {
      const client = fakeClient(netFailed({ kind: 'offline', message: 'no network' }))
      const result = await createListenbrainzTransport(options(client)).validateToken('tok')
      expect(result).toMatchObject({ ok: false, failure: { kind: 'offline' } })
    })
  })

  describe('submit', () => {
    it('posts the body as JSON with the token header, once, reading its error statuses', async () => {
      const client = fakeClient(netOk({ status: 'ok' }))
      const result = await createListenbrainzTransport(options(client)).submit('tok-abc', body)

      const [request] = client.posted
      expect(request.url).toBe(LISTENBRAINZ_SUBMIT_URL)
      expect(request.json).toEqual(body)
      expect(request.form).toBeUndefined()
      expect(request.headers?.authorization).toBe('Token tok-abc')
      // The outbox is the retry ladder — a POST retried after the server recorded
      // it is a duplicate listen.
      expect(request.maxAttempts).toBe(1)
      expect(request.acceptStatuses).toEqual([400, 401])
      expect(result).toEqual({ ok: true })
    })

    it('surfaces a 401 envelope as an auth failure with its status', async () => {
      const client = fakeClient(netOk({ code: 401, error: 'Invalid authorization token.' }))
      const result = await createListenbrainzTransport(options(client)).submit('tok', body)
      expect(result).toMatchObject({ ok: false, status: 401 })
    })

    it('surfaces a 400 envelope as a terminal failure with its status', async () => {
      const client = fakeClient(netOk({ code: 400, error: 'Invalid JSON document submitted.' }))
      const result = await createListenbrainzTransport(options(client)).submit('tok', body)
      expect(result).toMatchObject({ ok: false, status: 400 })
    })

    it('leaves a transient failure with no status of its own', async () => {
      const client = fakeClient(netFailed({ kind: 'unavailable', message: 'down' }))
      const result = await createListenbrainzTransport(options(client)).submit('tok', body)
      expect(result).toEqual({
        ok: false,
        failure: { kind: 'unavailable', message: 'down' },
        status: null
      })
    })
  })
})
