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

/** A transport that answers from a script, one responder per call. */
function fakeTransport(...responders: Responder[]): LastfmTransport & { calls: LastfmParams[] } {
  const calls: LastfmParams[] = []
  return {
    calls,
    call: async <T>(params: LastfmParams): Promise<LastfmCallResult<T>> => {
      calls.push(params)
      const responder = responders.shift()
      if (responder === undefined) throw new Error(`unscripted call: ${String(params.method)}`)
      return responder(params) as LastfmCallResult<T>
    }
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
      it('refuses when there is no application key, and opens no browser', async () => {
        const transport = fakeTransport()
        const result = await target(transport, fakeSettings('', '')).authorize()

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.failure.kind).toBe('declined')
        expect(harness.opened).toHaveLength(0)
        expect(transport.calls).toHaveLength(0)
      })

      it('refuses a half-filled override rather than falling back to the shipped key', async () => {
        const result = await target(fakeTransport(), fakeSettings('only-a-key', '')).authorize()

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.failure.message).toMatch(/both/i)
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

  describe('the parts W11-4 owns', () => {
    it('reports that it cannot send yet rather than pretending to', async () => {
      const lastfm = target(fakeTransport())
      const submitted = await lastfm.submit([])
      expect(submitted.ok).toBe(false)

      // Fire-and-forget by contract: no result to fail with, and it must not
      // throw into a caller that is forbidden from catching it.
      await expect(
        lastfm.nowPlaying({
          artistName: 'a',
          title: 't',
          albumTitle: null,
          albumArtistName: null,
          durationSeconds: null
        })
      ).resolves.toBeUndefined()
    })

    it('advertises Last.fm’s batch limit rather than leaving it to the drain', () => {
      expect(target(fakeTransport()).capabilities.batchLimit).toBe(50)
      expect(target(fakeTransport()).capabilities.supportsLove).toBe(true)
    })
  })
})
