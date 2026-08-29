/**
 * ListenBrainz's token flow, its submit semantics, and the same credential
 * confinement Last.fm's target proves — without a keyring or a socket.
 *
 * The point of this second target, and so of this file, is the abstraction: the
 * behaviours the drain worker relies on (a dead credential disconnects itself, a
 * whole-call failure backs off, an unparseable request drops its rows) are
 * reached here through an HTTP `401`/`400` rather than a numbered Last.fm error,
 * and the target still presents them the same way.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { netFailed, netOk, type NetResult } from '../../../src/shared/net'
import {
  createScrobbleCredentialStore,
  type CredentialFileIo,
  type CredentialSealer,
  type ScrobbleCredentialStore
} from '../../../src/main/scrobble/credentials'
import {
  createListenbrainzTarget,
  LISTENBRAINZ_BATCH_LIMIT
} from '../../../src/main/scrobble/listenbrainz/target'
import type { ListenbrainzSubmitBody } from '../../../src/main/scrobble/listenbrainz/listens'
import type {
  ListenbrainzIdentity,
  ListenbrainzTransport,
  ListenbrainzWriteResult
} from '../../../src/main/scrobble/listenbrainz/transport'
import type { NowPlayingPayload, ScrobbleSubmission } from '../../../src/shared/scrobble'

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

interface FakeTransport extends ListenbrainzTransport {
  readonly submits: { token: string; body: ListenbrainzSubmitBody }[]
  readonly validations: string[]
}

/** A scripted submit answer — synchronous, since the fake wraps it in a promise. */
type SubmitResponder = (token: string, body: ListenbrainzSubmitBody) => ListenbrainzWriteResult

/**
 * A transport that answers validate and submit from injected functions, and
 * records what it was handed — the token especially, since proving it reaches the
 * wire is proving the flow.
 */
function fakeTransport(opts?: {
  validate?: (token: string) => NetResult<ListenbrainzIdentity>
  submit?: SubmitResponder
}): FakeTransport {
  const submits: { token: string; body: ListenbrainzSubmitBody }[] = []
  const validations: string[] = []
  return {
    submits,
    validations,
    async validateToken(token) {
      validations.push(token)
      return (opts?.validate ?? (() => netOk({ userName: 'operator' })))(token)
    },
    async submit(token, body) {
      submits.push({ token, body })
      return (opts?.submit ?? (() => ({ ok: true }) as ListenbrainzWriteResult))(token, body)
    }
  }
}

interface Harness {
  credentials: ScrobbleCredentialStore
  sealer: ReturnType<typeof fakeSealer>
}

let harness: Harness

beforeEach(() => {
  const sealer = fakeSealer()
  harness = { sealer, credentials: createScrobbleCredentialStore({ sealer, io: memoryIo() }) }
})

function target(transport: ListenbrainzTransport) {
  return createListenbrainzTarget({ transport, credentials: harness.credentials })
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

const playing: NowPlayingPayload = {
  artistName: 'Artist',
  title: 'Track',
  albumTitle: 'Album',
  albumArtistName: null,
  durationSeconds: 200
}

describe('createListenbrainzTarget', () => {
  it('starts disconnected when nothing is stored', () => {
    expect(target(fakeTransport()).connection()).toEqual({
      target: 'listenbrainz',
      connected: false,
      username: null
    })
  })

  describe('authorize', () => {
    it('validates the token, then stores it and reports the username', async () => {
      const transport = fakeTransport()
      const lb = target(transport)
      const result = await lb.authorize({ token: 'user-token-abc' })

      expect(result).toEqual({
        ok: true,
        value: { target: 'listenbrainz', connected: true, username: 'operator' }
      })
      expect(transport.validations).toEqual(['user-token-abc'])
      expect(lb.connection().connected).toBe(true)
      // The token is the credential — sealed under `secret`, the field named for
      // what it is rather than for either service's word.
      expect(harness.credentials.read('listenbrainz')).toEqual({
        username: 'operator',
        secret: 'user-token-abc'
      })
    })

    it('trims the pasted token before validating and storing it', async () => {
      const transport = fakeTransport()
      await target(transport).authorize({ token: '  user-token-abc\n' })
      expect(transport.validations).toEqual(['user-token-abc'])
      expect(harness.credentials.read('listenbrainz')?.secret).toBe('user-token-abc')
    })

    it('rejects an empty paste without a round trip', async () => {
      const transport = fakeTransport()
      const result = await target(transport).authorize({ token: '   ' })

      expect(result.ok === false && result.failure.kind).toBe('rejected')
      expect(result.ok === false && result.failure.message).toMatch(/paste/i)
      expect(transport.validations).toHaveLength(0)
    })

    it('rejects when no input is supplied at all', async () => {
      const result = await target(fakeTransport()).authorize()
      expect(result.ok === false && result.failure.kind).toBe('rejected')
    })

    it('reports a token the service did not recognise, and stores nothing', async () => {
      const transport = fakeTransport({
        validate: () => netFailed({ kind: 'rejected', message: 'ListenBrainz did not recognise…' })
      })
      const result = await target(transport).authorize({ token: 'nope' })

      expect(result.ok).toBe(false)
      expect(harness.credentials.read('listenbrainz')).toBeNull()
    })

    it('refuses when there is nowhere secure to put the token, and does not send it', async () => {
      harness.sealer.available = false
      const transport = fakeTransport()
      const result = await target(transport).authorize({ token: 'user-token-abc' })

      expect(result.ok === false && result.failure.kind).toBe('declined')
      expect(result.ok === false && result.failure.message).toMatch(/keyring/i)
      // Checked before the token leaves the machine, the way Last.fm checks before
      // the browser opens.
      expect(transport.validations).toHaveLength(0)
    })
  })

  describe('the credential’s life', () => {
    it('survives a restart', async () => {
      await target(fakeTransport()).authorize({ token: 'user-token-abc' })

      // A second target over the same store is what a relaunch looks like: nothing
      // in memory, everything on disk.
      expect(target(fakeTransport()).connection()).toEqual({
        target: 'listenbrainz',
        connected: true,
        username: 'operator'
      })
    })

    it('is gone after disconnecting, in memory and on disk', async () => {
      const lb = target(fakeTransport())
      await lb.authorize({ token: 'user-token-abc' })
      await lb.disconnect()

      expect(lb.connection().connected).toBe(false)
      expect(harness.credentials.read('listenbrainz')).toBeNull()
      expect(target(fakeTransport()).connection().connected).toBe(false)
    })

    it('disconnecting twice is not an error', async () => {
      const lb = target(fakeTransport())
      await expect(lb.disconnect()).resolves.toBeUndefined()
      await expect(lb.disconnect()).resolves.toBeUndefined()
    })

    it('is never handed out — the connection carries a username and nothing else', async () => {
      const lb = target(fakeTransport())
      const result = await lb.authorize({ token: 'user-token-abc' })

      // Every field of everything this target hands upward, flattened. If the
      // token ever appears in one, it is one refactor away from IPC.
      const exposed = JSON.stringify([result, lb.connection()])
      expect(exposed).not.toContain('user-token-abc')
      expect(Object.keys(lb.connection()).sort()).toEqual(['connected', 'target', 'username'])
    })
  })

  it('advertises ListenBrainz’s own capabilities rather than Last.fm’s', () => {
    const capabilities = target(fakeTransport()).capabilities
    // The whole reason the number lives on the target: it is twenty times
    // Last.fm's, and the drain worker splits to it without knowing whose it is.
    expect(capabilities.batchLimit).toBe(LISTENBRAINZ_BATCH_LIMIT)
    expect(capabilities.batchLimit).toBe(1000)
    // No loves, so the enqueue path never routes one here.
    expect(capabilities.supportsLove).toBe(false)
    expect(capabilities.requiresDuration).toBe(false)
  })

  it('refuses a love rather than pretending to send one', async () => {
    const lb = target(fakeTransport())
    await expect(lb.love({ artistName: 'a', title: 't' })).resolves.toMatchObject({ ok: false })
    await expect(lb.unlove({ artistName: 'a', title: 't' })).resolves.toMatchObject({ ok: false })
  })

  describe('submit', () => {
    async function connected(submit?: SubmitResponder) {
      const transport = fakeTransport(submit ? { submit } : undefined)
      const lb = target(transport)
      await lb.authorize({ token: 'user-token-abc' })
      return Object.assign(lb, { transport })
    }

    it('sends an import body carrying the token, and accepts every row on a 200', async () => {
      const lb = await connected()
      const result = await lb.submit([submission(7, 1000), submission(8, 2000)])

      expect(result).toMatchObject({
        ok: true,
        value: [
          { id: 7, accepted: true },
          { id: 8, accepted: true }
        ]
      })
      const sent = lb.transport.submits.at(-1)
      expect(sent?.token).toBe('user-token-abc')
      expect(sent?.body.listen_type).toBe('import')
      expect(sent?.body.payload).toHaveLength(2)
      expect(sent?.body.payload[0]?.listened_at).toBe(1000)
      expect(sent?.body.payload[0]?.track_metadata.artist_name).toBe('Artist 7')
    })

    it('sends nothing and asks for nothing when the batch is empty', async () => {
      const lb = await connected()
      await expect(lb.submit([])).resolves.toMatchObject({ ok: true, value: [] })
      expect(lb.transport.submits).toHaveLength(0)
    })

    it('disconnects the account on a 401 without dropping the batch', async () => {
      const lb = await connected(() => ({
        ok: false,
        failure: { kind: 'rejected', message: 'ListenBrainz no longer accepts this token.' },
        status: 401
      }))

      const result = await lb.submit([submission(7, 1000), submission(8, 2000)])

      // A whole-call failure, so the drain backs the batch off rather than
      // dropping it — and the connection is already false, which halts the retry
      // loop the same way Last.fm's error 9 does.
      expect(result.ok).toBe(false)
      expect(lb.connection().connected).toBe(false)
      expect(harness.credentials.read('listenbrainz')).toBeNull()
    })

    it('drops the batch as per-item rejections on a 400, rather than wedging the outbox', async () => {
      const lb = await connected(() => ({
        ok: false,
        failure: { kind: 'rejected', message: 'ListenBrainz could not read this listen.' },
        status: 400
      }))

      const result = await lb.submit([submission(7, 1000), submission(8, 2000)])
      expect(result).toMatchObject({
        ok: true,
        value: [
          { id: 7, accepted: false },
          { id: 8, accepted: false }
        ]
      })
      // A bad request does not stand the account down — the token is fine.
      expect(lb.connection().connected).toBe(true)
    })

    it('backs the whole batch off on a transient failure', async () => {
      const lb = await connected(() => ({
        ok: false,
        failure: { kind: 'unavailable', message: 'ListenBrainz is temporarily unavailable.' },
        status: null
      }))

      const result = await lb.submit([submission(7, 1000)])
      expect(result).toMatchObject({ ok: false, failure: { kind: 'unavailable' } })
      expect(lb.connection().connected).toBe(true)
    })

    it('fails the call rather than sending with no account connected', async () => {
      const lb = target(fakeTransport())
      await expect(lb.submit([submission(7, 1000)])).resolves.toMatchObject({ ok: false })
    })
  })

  describe('nowPlaying', () => {
    async function connected(submit?: SubmitResponder) {
      const transport = fakeTransport(submit ? { submit } : undefined)
      const lb = target(transport)
      await lb.authorize({ token: 'user-token-abc' })
      return Object.assign(lb, { transport })
    }

    it('sends a playing_now body with no timestamp', async () => {
      const lb = await connected()
      await lb.nowPlaying(playing)

      const sent = lb.transport.submits.at(-1)
      expect(sent?.body.listen_type).toBe('playing_now')
      expect(sent?.body.payload).toHaveLength(1)
      expect(sent?.body.payload[0]?.listened_at).toBeUndefined()
      expect(sent?.body.payload[0]?.track_metadata.track_name).toBe('Track')
    })

    it('swallows a failure and never rejects', async () => {
      const lb = await connected(() => ({
        ok: false,
        failure: { kind: 'offline', message: 'no' },
        status: null
      }))
      await expect(lb.nowPlaying(playing)).resolves.toBeUndefined()
    })

    it('does not send, or reject, with no account connected', async () => {
      const transport = fakeTransport()
      await expect(target(transport).nowPlaying(playing)).resolves.toBeUndefined()
      expect(transport.submits).toHaveLength(0)
    })

    it('still disconnects the account when the token is dead', async () => {
      const lb = await connected(() => ({
        ok: false,
        failure: { kind: 'rejected', message: 'dead' },
        status: 401
      }))
      await lb.nowPlaying(playing)
      expect(lb.connection().connected).toBe(false)
    })
  })
})
