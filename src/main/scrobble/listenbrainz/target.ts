/**
 * ListenBrainz as a `ScrobbleTarget`: the token flow, and the credential's whole
 * life — **D19**, W11-8.
 *
 * ## The flow, and how little of one it is
 *
 * There is no browser round trip and nothing to poll. The operator pastes a user
 * token from their ListenBrainz settings page; `authorize` checks it names an
 * account with one call to `validate-token`, and on success seals it. That is the
 * entire flow, and it is the point of this being the second target: Last.fm's
 * `authorize` drives a minutes-long browser sign-in and needs a `cancelAuthorize`
 * to abandon it, while this one resolves in a single short request and needs
 * neither. The abstraction has to hold both, and the `input.token` argument on
 * `authorize` is the seam where it does.
 *
 * ## The credential
 *
 * The token is the credential — there is no session key exchanged for it, the way
 * Last.fm trades a request token for a session key. It goes from `authorize`'s
 * argument straight into `safeStorage` and is read back only here, only to sign a
 * submit with its header. It is not in the settings table, not in D11's bundle,
 * and there is no code path from it to IPC after it is written: the renderer's
 * whole view of it is `ScrobbleConnection`, a username and a boolean.
 * `disconnect()` deletes Oscine's copy, which is all Oscine can do — revoking the
 * token belongs to the operator, on their ListenBrainz settings page.
 *
 * ## No loves
 *
 * `capabilities.supportsLove` is false, and `love`/`unlove` are therefore never
 * called (the enqueue path gates on the flag — see `favorites/store.ts`). They
 * are implemented to refuse rather than to lie, so that a caller which reached
 * them despite the flag gets a `rejected` rather than a silent success.
 */

import { netFailed, netOk, type NetResult } from '@shared/net'
import type {
  LovePayload,
  NowPlayingPayload,
  ScrobbleAuthorizeInput,
  ScrobbleConnection,
  ScrobbleSubmission,
  ScrobbleSubmissionResult,
  ScrobbleTarget,
  ScrobbleTargetCapabilities
} from '@shared/scrobble'
import {
  CredentialSealingUnavailableError,
  type ScrobbleCredential,
  type ScrobbleCredentialStore
} from '../credentials'
import { nowPlayingBody, submitBody } from './listens'
import type { ListenbrainzTransport } from './transport'

/**
 * ListenBrainz's per-request ceiling (`MAX_LISTENS_PER_REQUEST`), and the reason
 * `capabilities.batchLimit` is a number the target owns rather than the drain
 * worker assumes. It is twenty times Last.fm's fifty — the difference this field
 * exists to carry, and the drain worker splits to it without knowing whose it is.
 */
export const LISTENBRAINZ_BATCH_LIMIT = 1000

const CAPABILITIES: ScrobbleTargetCapabilities = {
  batchLimit: LISTENBRAINZ_BATCH_LIMIT,
  // ListenBrainz has no "loved recording" concept Oscine can reach without a
  // MusicBrainz id it does not hold, so a love has nowhere to go. Declared false
  // rather than implemented and failing: the enqueue never happens.
  supportsLove: false,
  // A listen with no duration is a slightly poorer listen, not an unsendable one
  // — ListenBrainz stores it either way.
  requiresDuration: false
}

export interface ListenbrainzTargetOptions {
  transport: ListenbrainzTransport
  credentials: ScrobbleCredentialStore
}

const NOT_CONNECTED: ScrobbleConnection = {
  target: 'listenbrainz',
  connected: false,
  username: null
}

export function createListenbrainzTarget({
  transport,
  credentials
}: ListenbrainzTargetOptions): ScrobbleTarget {
  /**
   * The credential, cached after the first read — `undefined` means "not looked
   * at", `null` means "looked, and there is none". Both `authorize` and
   * `disconnect` write through, so the cache cannot outlive the truth.
   */
  let cached: ScrobbleCredential | null | undefined

  const current = (): ScrobbleCredential | null => {
    if (cached === undefined) cached = credentials.read('listenbrainz')
    return cached
  }

  const connection = (): ScrobbleConnection => {
    const credential = current()
    return credential === null
      ? NOT_CONNECTED
      : { target: 'listenbrainz', connected: true, username: credential.username }
  }

  /**
   * A dead token disconnects the account, the way Last.fm's error 9 does.
   *
   * The drain worker's ordinary "skip disconnected targets" guard then halts the
   * retry loop without a special failure kind for re-authorization — the same
   * contract, reached through a `401` rather than a numbered error.
   */
  const forgetIfUnauthorized = (status: number | null): void => {
    if (status === 401) {
      credentials.clear('listenbrainz')
      cached = null
    }
  }

  return {
    id: 'listenbrainz',
    capabilities: CAPABILITIES,
    connection,

    async authorize(input?: ScrobbleAuthorizeInput): Promise<NetResult<ScrobbleConnection>> {
      const token = input?.token?.trim() ?? ''
      if (token === '') {
        return netFailed({
          kind: 'rejected',
          message: 'Paste your ListenBrainz user token to connect.'
        })
      }

      // Checked before the token is sent, not after: discovering there is no
      // keyring to seal it in only once the service has confirmed it would be the
      // same failure delivered a round trip later. See `lastfm/target.ts`.
      if (!credentials.available()) {
        return netFailed({
          kind: 'declined',
          message: new CredentialSealingUnavailableError().message
        })
      }

      const identity = await transport.validateToken(token)
      if (!identity.ok) return netFailed(identity.failure)

      const credential: ScrobbleCredential = { username: identity.value.userName, secret: token }
      try {
        credentials.write('listenbrainz', credential)
      } catch (err) {
        return netFailed({
          kind: 'declined',
          message:
            err instanceof CredentialSealingUnavailableError
              ? err.message
              : 'Oscine could not save the ListenBrainz sign-in.'
        })
      }
      cached = credential
      return netOk(connection())
    },

    async disconnect(): Promise<void> {
      credentials.clear('listenbrainz')
      cached = null
    },

    /**
     * Announce the track, fire-and-forget. Every failure is dropped — including a
     * dead token, which still disconnects the account on the way past — and this
     * method never throws, because it is called from the transport-commit path
     * where nothing is prepared to catch. See `ScrobbleTarget.nowPlaying`.
     */
    async nowPlaying(payload: NowPlayingPayload): Promise<void> {
      try {
        const credential = current()
        if (credential === null) return
        const result = await transport.submit(credential.secret, nowPlayingBody(payload))
        if (!result.ok) forgetIfUnauthorized(result.status)
      } catch {
        // `transport.submit` returns failures rather than throwing; reaching here
        // is a bug below this line, and still not a reason to take down the
        // player's transport.
      }
    },

    async submit(
      batch: readonly ScrobbleSubmission[]
    ): Promise<NetResult<ScrobbleSubmissionResult[]>> {
      // A batch of nothing is a caller bug, not a request.
      if (batch.length === 0) return netOk([])

      const credential = current()
      if (credential === null) {
        return netFailed({ kind: 'rejected', message: 'No ListenBrainz account is connected.' })
      }

      const result = await transport.submit(credential.secret, submitBody(batch))
      if (result.ok) {
        // ListenBrainz accepts or refuses a submit whole — a 200 is every listen
        // in it accepted, so each row echoes back accepted.
        return netOk(batch.map(({ id }) => ({ id, accepted: true })))
      }

      if (result.status === 401) {
        forgetIfUnauthorized(result.status)
        return netFailed(result.failure)
      }

      // A 400 is a request ListenBrainz will not parse, and it says so about the
      // whole submit — retrying is the one thing that certainly does not work, so
      // every row is rejected and the queue drains past them. The same
      // over-reach as Last.fm's error 6, kept rare by the same upstream guard:
      // `scrobbleEnqueueRejection` refuses a row with no artist or title at
      // enqueue.
      if (result.status === 400) {
        return netOk(
          batch.map(({ id }) => ({ id, accepted: false, reason: result.failure.message }))
        )
      }

      // Transient (status null): the whole batch backs off and retries.
      return netFailed(result.failure)
    },

    // Never called — `capabilities.supportsLove` is false. Refuses rather than
    // pretends, so a caller that ignored the flag learns it did.
    async love(_payload: LovePayload): Promise<NetResult<void>> {
      return netFailed({
        kind: 'rejected',
        message: 'ListenBrainz does not support loving tracks.'
      })
    },

    async unlove(_payload: LovePayload): Promise<NetResult<void>> {
      return netFailed({
        kind: 'rejected',
        message: 'ListenBrainz does not support loving tracks.'
      })
    }
  }
}
