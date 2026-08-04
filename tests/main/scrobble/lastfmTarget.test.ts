/**
 * The desktop auth flow, end to end, without a browser or a keyring.
 *
 * Two of these tests are about things that must happen *before* the browser
 * opens — no application key, and no keyring — because discovering either of
 * them afterwards means an operator typed their Last.fm password for nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { LASTFM_API_KEY, LASTFM_API_SECRET } from '../../../src/shared/settings'
import {
  createScrobbleCredentialStore,
  type CredentialFileIo,
  type CredentialSealer,
  type ScrobbleCredentialStore
} from '../../../src/main/scrobble/credentials'
import type { AppKeySettingsSource } from '../../../src/main/scrobble/lastfm/appKey'
import { createLastfmTarget, LASTFM_AUTH_PAGE } from '../../../src/main/scrobble/lastfm/target'
import {
  LASTFM_ERROR,
  type LastfmCallResult,
  type LastfmTransport
} from '../../../src/main/scrobble/lastfm/transport'
import type { LastfmParams } from '../../../src/main/scrobble/lastfm/signature'
import type { ScrobbleSubmission } from '../../../src/shared/scrobble'

function memoryIo(): CredentialFileIo {
  let contents: string | null = null
  return {
    read: () => contents,
    write: (next) => {
      contents = next
    },
    remove: () => {
      contents = null
    }
  }
}

function fakeSealer(available = true): CredentialSealer & { available: boolean } {
  const sealer = {
    available,
    isEncryptionAvailable: () => sealer.available,
    encryptString: (plain: string) => Buffer.from([...Buffer.from(plain, 'utf8')].reverse()),
    decryptString: (sealed: Buffer) => Buffer.from([...sealed].reverse()).toString('utf8')
  }
  return sealer
}

/** Settings with an override, or without one. */
function fakeSettings(
  apiKey = 'operator-key',
  apiSecret = 'operator-secret'
): AppKeySettingsSource {
  return {
    get: <T>(key: string): T => {
      if (key === LASTFM_API_KEY) return apiKey as T
      if (key === LASTFM_API_SECRET) return apiSecret as T
      throw new RangeError(`unexpected key: ${key}`)
    }
  }
}

type Responder = (
  params: LastfmParams
) => LastfmCallResult<unknown> | Promise<LastfmCallResult<unknown>>

/**
 * A transport that answers from a script, one responder per call.
 *
 * `call` and `post` draw from the same queue and record into the same list, so
 * a test scripts what it expects in order and does not have to know which verb
 * the target chose. `verbs` is there for the one test that does — that the
 * writes go out as POST, which is not a detail the target may quietly change.
 */
function fakeTransport(
  ...responders: Responder[]
): LastfmTransport & { calls: LastfmParams[]; verbs: ('call' | 'post')[] } {
  const calls: LastfmParams[] = []
  const verbs: ('call' | 'post')[] = []
  const answer = async <T>(
    verb: 'call' | 'post',
    params: LastfmParams
  ): Promise<LastfmCallResult<T>> => {
    calls.push(params)
    verbs.push(verb)
    const responder = responders.shift()
    if (responder === undefined) throw new Error(`unscripted call: ${String(params.method)}`)
    return (await responder(params)) as LastfmCallResult<T>
  }
  return {
    calls,
    verbs,
    call: (params) => answer('call', params),
    post: (params) => answer('post', params)
  }
}

const tokenOk: Responder = () => ({ ok: true, value: { token: 'request-token' } })

const sessionOk: Responder = () => ({
  ok: true,
  value: { session: { name: 'operator', key: 'session-key-abc' } }
})

const notApprovedYet: Responder = () => ({
  ok: false,
  failure: { kind: 'rejected', message: 'Nobody has approved this sign-in request yet.' },
  code: LASTFM_ERROR.unauthorizedToken
})

interface Harness {
  credentials: ScrobbleCredentialStore
  sealer: ReturnType<typeof fakeSealer>
  opened: string[]
}

let harness: Harness

beforeEach(() => {
  const sealer = fakeSealer()
  harness = {
    sealer,
    credentials: createScrobbleCredentialStore({ sealer, io: memoryIo() }),
    opened: []
  }
})

function target(
  transport: LastfmTransport,
  settings: AppKeySettingsSource = fakeSettings(),
  overrides: Partial<Parameters<typeof createLastfmTarget>[0]> = {}
) {
  return createLastfmTarget({
    transport,
    credentials: harness.credentials,
    settings,
    openExternal: async (url) => {
      harness.opened.push(url)
    },
    // No real waiting: the flow's timing is its own to test, not every test's to
    // sit through.
    sleep: async () => {},
    ...overrides
  })
}

describe('createLastfmTarget', () => {
  it('starts disconnected when nothing is stored', () => {
    expect(target(fakeTransport()).connection()).toEqual({
      target: 'lastfm',
      connected: false,
      username: null
    })
  })

  describe('authorize', () => {
    it('opens the system browser at the auth page with the token', async () => {
      const result = await target(fakeTransport(tokenOk, sessionOk)).authorize()

      expect(result.ok).toBe(true)
      expect(harness.opened).toHaveLength(1)
      const page = new URL(harness.opened[0])
      expect(`${page.origin}${page.pathname}`).toBe(LASTFM_AUTH_PAGE)
      expect(page.searchParams.get('token')).toBe('request-token')
      expect(page.searchParams.get('api_key')).toBe('operator-key')
    })

    it('stores the session key and reports the username', async () => {
      const lastfm = target(fakeTransport(tokenOk, sessionOk))
      const result = await lastfm.authorize()

      expect(result).toEqual({
        ok: true,
        value: { target: 'lastfm', connected: true, username: 'operator' }
      })
      expect(lastfm.connection().connected).toBe(true)
      expect(harness.credentials.read('lastfm')).toEqual({
        username: 'operator',
        secret: 'session-key-abc'
      })
    })

    it('keeps asking while the operator is still in their browser', async () => {
      const transport = fakeTransport(tokenOk, notApprovedYet, notApprovedYet, sessionOk)
      const result = await target(transport).authorize()

      expect(result.ok).toBe(true)
      expect(transport.calls.filter((call) => call.method === 'auth.getSession')).toHaveLength(3)
    })

    it('stops on any answer that is not “not approved yet”', async () => {
      const badKey: Responder = () => ({
        ok: false,
        failure: { kind: 'rejected', message: 'Last.fm rejected this application’s API key.' },
        code: LASTFM_ERROR.invalidApiKey
      })
      const transport = fakeTransport(tokenOk, badKey)
      const result = await target(transport).authorize()

      expect(result.ok).toBe(false)
      expect(harness.credentials.read('lastfm')).toBeNull()
      // One getSession and no more: the point is that it did not keep polling a
      // condition that will never change.
      expect(transport.calls.filter((call) => call.method === 'auth.getSession')).toHaveLength(1)
    })

    it('gives up quietly once the wait is over', async () => {
      let clock = 0
      const transport = fakeTransport(tokenOk, notApprovedYet, notApprovedYet)
      const result = await target(transport, fakeSettings(), {
        now: () => (clock += 60_000),
        timeoutMs: 90_000
      }).authorize()

      expect(result.ok).toBe(false)
      expect(result.ok === false && result.failure.kind).toBe('timeout')
    })

    it('can be abandoned by the operator', async () => {
      const lastfm = target(
        fakeTransport(tokenOk, () => {
          // Cancelled while the reply was in flight, which is the realistic
          // moment: the click lands between two polls, not between two ticks.
          lastfm.cancelAuthorize()
          return notApprovedYet({})
        })
      )
      const result = await lastfm.authorize()

      expect(result.ok).toBe(false)
      expect(result.ok === false && result.failure.kind).toBe('cancelled')
      expect(harness.credentials.read('lastfm')).toBeNull()
    })

    it('refuses a second sign-in while one is waiting', async () => {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const lastfm = target(
        fakeTransport(async () => {
          await held
          return { ok: false, failure: { kind: 'cancelled', message: 'x' }, code: null }
        })
      )

      const first = lastfm.authorize()
      const second = await lastfm.authorize()

      expect(second.ok).toBe(false)
      expect(second.ok === false && second.failure.message).toMatch(/already waiting/i)

      release()
      await first
    })

    describe('before anything leaves the machine', () => {
      /**
       * A half-filled override, which is the only way a build that ships a
       * registered pair can end up with no usable key.
       *
       * Both fields empty resolves to the shipped pair now that one exists — see
       * `lastfmAppKey.test.ts`. The refusal itself is not dead code: it is what a
       * build whose key had been withdrawn and blanked would do, and it is the
       * reason a half-filled override does not silently fall back.
       */
      it('refuses a half-filled override, and opens no browser', async () => {
        const transport = fakeTransport()
        const result = await target(transport, fakeSettings('only-a-key', '')).authorize()

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.failure.kind).toBe('declined')
        expect(result.ok === false && result.failure.message).toMatch(/both/i)
        expect(harness.opened).toHaveLength(0)
        expect(transport.calls).toHaveLength(0)
      })

      it('refuses when there is nowhere secure to put the credential', async () => {
        harness.sealer.available = false
        const transport = fakeTransport()
        const result = await target(transport).authorize()

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.failure.kind).toBe('declined')
        expect(result.ok === false && result.failure.message).toMatch(/keyring/i)
        // The part that matters: nobody typed a password first.
        expect(harness.opened).toHaveLength(0)
        expect(transport.calls).toHaveLength(0)
      })
    })

    describe('when Last.fm answers with nonsense', () => {
      it('reports an unreadable token rather than opening a browser at nothing', async () => {
        const result = await target(fakeTransport(() => ({ ok: true, value: {} }))).authorize()

        expect(result.ok === false && result.failure.kind).toBe('malformed')
        expect(harness.opened).toHaveLength(0)
      })

      it('reports an unreadable session rather than storing an empty key', async () => {
        const result = await target(
          fakeTransport(tokenOk, () => ({ ok: true, value: { session: { name: 'operator' } } }))
        ).authorize()

        expect(result.ok === false && result.failure.kind).toBe('malformed')
        expect(harness.credentials.read('lastfm')).toBeNull()
      })
    })
  })

  describe('the credential’s life', () => {
    it('survives a restart', async () => {
      await target(fakeTransport(tokenOk, sessionOk)).authorize()

      // A second target over the same store is what a relaunch looks like from
      // here: nothing in memory, everything on disk.
      const afterRestart = target(fakeTransport())
      expect(afterRestart.connection()).toEqual({
        target: 'lastfm',
        connected: true,
        username: 'operator'
      })
    })

    it('is gone after disconnecting, in memory and on disk', async () => {
      const lastfm = target(fakeTransport(tokenOk, sessionOk))
      await lastfm.authorize()
      await lastfm.disconnect()

      expect(lastfm.connection().connected).toBe(false)
      expect(harness.credentials.read('lastfm')).toBeNull()
      expect(target(fakeTransport()).connection().connected).toBe(false)
    })

    it('disconnecting twice is not an error', async () => {
      const lastfm = target(fakeTransport())
      await expect(lastfm.disconnect()).resolves.toBeUndefined()
      await expect(lastfm.disconnect()).resolves.toBeUndefined()
    })

    it('is never handed out — the connection carries a username and nothing else', async () => {
      const lastfm = target(fakeTransport(tokenOk, sessionOk))
      const result = await lastfm.authorize()

      // Every field of everything this target hands upward, flattened. If a
      // session key ever appears in one, it is one refactor away from IPC.
      const exposed = JSON.stringify([result, lastfm.connection()])
      expect(exposed).not.toContain('session-key-abc')
      expect(Object.keys(lastfm.connection()).sort()).toEqual(['connected', 'target', 'username'])
    })
  })

  it('advertises Last.fm’s batch limit rather than leaving it to the drain', () => {
    expect(target(fakeTransport()).capabilities.batchLimit).toBe(50)
    expect(target(fakeTransport()).capabilities.supportsLove).toBe(true)
  })

  it('reports that loves are not implemented rather than pretending to send them', async () => {
    const lastfm = target(fakeTransport())
    // W11-6's card, not this one. It fails loudly rather than resolving `ok`,
    // because a love that silently goes nowhere is worse than one that says so.
    await expect(lastfm.love({ artistName: 'a', title: 't' })).resolves.toMatchObject({ ok: false })
    await expect(lastfm.unlove({ artistName: 'a', title: 't' })).resolves.toMatchObject({
      ok: false
    })
  })

  describe('submit', () => {
    /** Sign in, then hand back a target whose next calls are the scripted ones. */
    async function connected(
      ...responders: Responder[]
    ): Promise<ReturnType<typeof target> & { transport: ReturnType<typeof fakeTransport> }> {
      const transport = fakeTransport(tokenOk, sessionOk, ...responders)
      const lastfm = target(transport)
      await lastfm.authorize()
      return Object.assign(lastfm, { transport })
    }

    const submission = (id: number, timestamp: number): ScrobbleSubmission => ({
      id,
      payload: {
        artistName: `Artist ${id}`,
        title: `Track ${id}`,
        albumTitle: 'Album',
        albumArtistName: null,
        durationSeconds: 200,
        timestamp
      }
    })

    /** Last.fm's reply for a run of accepted scrobbles, in submission order. */
    const acceptedReply = (timestamps: number[]): LastfmCallResult<unknown> => ({
      ok: true,
      value: {
        scrobbles: {
          '@attr': { accepted: timestamps.length, ignored: 0 },
          scrobble: timestamps.map((timestamp) => ({
            artist: { corrected: '0', '#text': 'Artist' },
            track: { corrected: '0', '#text': 'Track' },
            timestamp: String(timestamp),
            ignoredMessage: { code: '0', '#text': '' }
          }))
        }
      }
    })

    it('POSTs the batch with the session key and array-indexed parameters', async () => {
      const lastfm = await connected(() => acceptedReply([1000, 2000]))
      const result = await lastfm.submit([submission(7, 1000), submission(8, 2000)])

      expect(result).toMatchObject({
        ok: true,
        value: [
          { id: 7, accepted: true },
          { id: 8, accepted: true }
        ]
      })

      const sent = lastfm.transport.calls.at(-1)
      expect(lastfm.transport.verbs.at(-1)).toBe('post')
      expect(sent?.method).toBe('track.scrobble')
      expect(sent?.sk).toBe('session-key-abc')
      expect(sent?.['artist[0]']).toBe('Artist 7')
      expect(sent?.['track[1]']).toBe('Track 8')
      expect(sent?.['timestamp[1]']).toBe('2000')
      // Seconds, not milliseconds: a millisecond value accepted as seconds dates
      // the scrobble to the year 56000.
      expect(sent?.['timestamp[0]']).toBe('1000')
    })

    it('sends nothing and asks for nothing when the batch is empty', async () => {
      const lastfm = await connected()
      await expect(lastfm.submit([])).resolves.toMatchObject({ ok: true, value: [] })
      expect(lastfm.transport.calls.filter((c) => c.method === 'track.scrobble')).toHaveLength(0)
    })

    it('returns per-item rejections for the scrobbles Last.fm ignored', async () => {
      const lastfm = await connected(() => ({
        ok: true,
        value: {
          scrobbles: {
            '@attr': { accepted: 1, ignored: 1 },
            scrobble: [
              { timestamp: '1000', ignoredMessage: { code: '0', '#text': '' } },
              { timestamp: '2000', ignoredMessage: { code: '1', '#text': 'Artist ignored' } }
            ]
          }
        }
      }))

      const result = await lastfm.submit([submission(7, 1000), submission(8, 2000)])
      expect(result).toMatchObject({
        ok: true,
        value: [
          { id: 7, accepted: true },
          { id: 8, accepted: false }
        ]
      })
    })

    it('disconnects the account on error 9 without failing every row', async () => {
      const lastfm = await connected(() => ({
        ok: false,
        failure: { kind: 'rejected', message: 'Last.fm no longer accepts this sign-in.' },
        code: LASTFM_ERROR.invalidSessionKey
      }))

      const result = await lastfm.submit([submission(7, 1000), submission(8, 2000)])

      // A whole-call failure, so the drain backs the batch off rather than
      // dropping it — and the connection is already false by the time it looks,
      // which is what stops it burning an attempt on all fifty rows.
      expect(result.ok).toBe(false)
      expect(lastfm.connection().connected).toBe(false)
      expect(lastfm.connection().username).toBeNull()
    })

    it('does not disconnect the account over a rate limit', async () => {
      const lastfm = await connected(() => ({
        ok: false,
        failure: { kind: 'rate-limited', message: 'Last.fm asked us to slow down.' },
        code: LASTFM_ERROR.rateLimitExceeded
      }))

      const result = await lastfm.submit([submission(7, 1000)])
      expect(result).toMatchObject({ ok: false, failure: { kind: 'rate-limited' } })
      // Retryable: the credential is fine and the rows must stay sendable.
      expect(lastfm.connection().connected).toBe(true)
    })

    it('drops the batch rather than wedging the outbox on error 6', async () => {
      const lastfm = await connected(() => ({
        ok: false,
        failure: { kind: 'rejected', message: 'Invalid parameters.' },
        code: LASTFM_ERROR.invalidParameters
      }))

      const result = await lastfm.submit([submission(7, 1000), submission(8, 2000)])
      // Per-item rejections rather than a call failure: a payload Last.fm will
      // not parse is one it will not parse next time either, and a retry loop
      // here is an outbox that never drains.
      expect(result).toMatchObject({
        ok: true,
        value: [
          { id: 7, accepted: false },
          { id: 8, accepted: false }
        ]
      })
      expect(lastfm.connection().connected).toBe(true)
    })

    it('fails the call rather than sending with no account connected', async () => {
      const lastfm = target(fakeTransport())
      await expect(lastfm.submit([submission(7, 1000)])).resolves.toMatchObject({ ok: false })
    })
  })

  describe('nowPlaying', () => {
    const playing = {
      artistName: 'Artist',
      title: 'Track',
      albumTitle: 'Album',
      albumArtistName: null,
      durationSeconds: 200
    }

    it('POSTs updateNowPlaying with no timestamp', async () => {
      const transport = fakeTransport(tokenOk, sessionOk, () => ({ ok: true, value: {} }))
      const lastfm = target(transport)
      await lastfm.authorize()
      await lastfm.nowPlaying(playing)

      const sent = transport.calls.at(-1)
      expect(transport.verbs.at(-1)).toBe('post')
      expect(sent?.method).toBe('track.updateNowPlaying')
      expect(sent?.artist).toBe('Artist')
      // The message *is* the claim that this is happening now.
      expect(sent?.timestamp).toBeUndefined()
      expect(Object.keys(sent ?? {}).some((key) => key.includes('['))).toBe(false)
    })

    it('swallows a failure and never rejects', async () => {
      const transport = fakeTransport(tokenOk, sessionOk, () => ({
        ok: false,
        failure: { kind: 'offline', message: 'no' },
        code: null
      }))
      const lastfm = target(transport)
      await lastfm.authorize()

      // It is called from the transport-commit path, where nothing is prepared
      // to catch — and there is no caller who could act on the outcome anyway.
      await expect(lastfm.nowPlaying(playing)).resolves.toBeUndefined()
    })

    it('does not reject, or call out, with no account connected', async () => {
      const transport = fakeTransport()
      await expect(target(transport).nowPlaying(playing)).resolves.toBeUndefined()
      expect(transport.calls).toHaveLength(0)
    })

    it('still disconnects the account when the session is dead', async () => {
      const transport = fakeTransport(tokenOk, sessionOk, () => ({
        ok: false,
        failure: { kind: 'rejected', message: 'dead' },
        code: LASTFM_ERROR.invalidSessionKey
      }))
      const lastfm = target(transport)
      await lastfm.authorize()
      await lastfm.nowPlaying(playing)

      expect(lastfm.connection().connected).toBe(false)
    })
  })

  describe('love and unlove', () => {
    const song = { artistName: 'Talk Talk', title: 'I Believe In You' }

    /** Sign in, then hand back a target whose next calls are the scripted ones. */
    async function signedIn(
      ...responders: Responder[]
    ): Promise<ReturnType<typeof target> & { transport: ReturnType<typeof fakeTransport> }> {
      const transport = fakeTransport(tokenOk, sessionOk, ...responders)
      const lastfm = target(transport)
      await lastfm.authorize()
      return Object.assign(lastfm, { transport })
    }

    it('POSTs track.love with the artist and title and nothing else', async () => {
      const lastfm = await signedIn(() => ({ ok: true, value: {} }))
      const result = await lastfm.love(song)

      expect(result.ok).toBe(true)
      const sent = lastfm.transport.calls.at(-1)
      expect(lastfm.transport.verbs.at(-1)).toBe('post')
      expect(sent?.method).toBe('track.love')
      expect(sent?.artist).toBe('Talk Talk')
      expect(sent?.track).toBe('I Believe In You')
      // A love is about the song, not the copy that was playing. Last.fm has no
      // parameter for any of these and would ignore them if it did.
      expect(sent?.album).toBeUndefined()
      expect(sent?.duration).toBeUndefined()
      expect(sent?.timestamp).toBeUndefined()
    })

    it('sends track.unlove for the withdrawal, same two parameters', async () => {
      const lastfm = await signedIn(() => ({ ok: true, value: {} }))
      const result = await lastfm.unlove(song)

      expect(result.ok).toBe(true)
      const sent = lastfm.transport.calls.at(-1)
      expect(sent?.method).toBe('track.unlove')
      expect(sent?.artist).toBe('Talk Talk')
      expect(sent?.track).toBe('I Believe In You')
    })

    it('signs with the session key, which the caller never supplies', async () => {
      const lastfm = await signedIn(() => ({ ok: true, value: {} }))
      await lastfm.love(song)

      // The credential is read here, per call, and `LovePayload` has nowhere to
      // put one — which is the property D19 is about.
      expect(lastfm.transport.calls.at(-1)?.sk).toBe('session-key-abc')
      expect(lastfm.transport.calls.at(-1)?.api_key).toBe('operator-key')
    })

    it('reports a failure rather than swallowing it, unlike nowPlaying', async () => {
      const lastfm = await signedIn(() => ({
        ok: false,
        failure: { kind: 'offline', message: 'no network' },
        code: null
      }))

      // A love is queued, so there is a reader for the outcome: the drain worker
      // backs the row off and tries again.
      expect(await lastfm.love(song)).toEqual({
        ok: false,
        failure: { kind: 'offline', message: 'no network' }
      })
    })

    it('surfaces a refusal as `rejected`, which is what the drain worker drops on', async () => {
      const lastfm = await signedIn(() => ({
        ok: false,
        failure: { kind: 'rejected', message: 'Last.fm would not accept this love.' },
        code: LASTFM_ERROR.invalidParameters
      }))

      const result = await lastfm.love(song)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.failure.kind).toBe('rejected')
    })

    it('disconnects the account when the session is refused', async () => {
      const lastfm = await signedIn(() => ({
        ok: false,
        failure: { kind: 'rejected', message: 'dead' },
        code: LASTFM_ERROR.invalidSessionKey
      }))

      const result = await lastfm.love(song)

      expect(result.ok).toBe(false)
      // Before returning, so the drain worker's re-read of `connection()` finds
      // it stood down and halts without burning an attempt on every queued row.
      expect(lastfm.connection().connected).toBe(false)
    })

    it('sends nothing with no account connected', async () => {
      const transport = fakeTransport()
      const result = await target(transport).love(song)

      expect(result.ok).toBe(false)
      expect(transport.calls).toHaveLength(0)
    })
  })
})
