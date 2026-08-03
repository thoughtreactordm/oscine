/**
 * Last.fm as a `ScrobbleTarget`: the desktop auth flow, and the credential's
 * whole life — **D19**, W11-3.
 *
 * ## The flow, and the one thing it is not
 *
 * 1. `auth.getToken` returns a request token that identifies nobody.
 * 2. Fermata opens the **system browser** at `last.fm/api/auth/`.
 * 3. The operator signs in and grants access, in their browser, to Last.fm.
 * 4. `auth.getSession` exchanges the now-authorized token for a session key
 *    bound to that account, which never expires.
 *
 * Step 2 is a `shell.openExternal`, never a `BrowserWindow`, and that is a
 * security property rather than a convenience. An in-app window rendering
 * somebody's login form is structurally indistinguishable from a phishing page:
 * the operator is typing the password to an account Fermata does not own, and
 * they are entitled to their own URL bar, their own padlock, their own password
 * manager and their own saved session. A window Fermata controls offers none of
 * those and could, in principle, read the form. The fact that this one does not
 * is exactly the assurance the operator has no way to check — so the flow does
 * not ask them to take it on trust.
 *
 * ## Why it polls
 *
 * There is no callback. Last.fm's desktop flow ends in the browser, with a page
 * that says "you may now close this window"; nothing tells the app. The
 * alternatives are a local HTTP listener with a redirect URI — which means
 * opening a port on the operator's machine for a service that does not require
 * one — or asking the operator to come back and press a second button, which is
 * a worse version of waiting. So `auth.getSession` is called on a timer until it
 * stops answering "nobody has approved this yet" (error 14), and error 14 is the
 * whole reason `acceptStatuses` exists in the net client.
 *
 * The wait is bounded. A token Last.fm never sees approved is not an error
 * condition — it is somebody who closed the tab — so it ends quietly after a few
 * minutes rather than polling until the token expires an hour later.
 *
 * ## The credential
 *
 * The session key goes straight from `auth.getSession` into `safeStorage` and is
 * read back only by this file, only to sign a call. It is not in the settings
 * table, not in D11's bundle, and there is no code path from it to IPC: the
 * renderer's entire view of it is `ScrobbleConnection`, a username and a
 * boolean. `disconnect()` deletes it, which is the whole of signing out — the
 * key is not revoked at Last.fm, because Fermata cannot revoke it and the
 * operator can, from their account's applications page.
 */

import { netFailed, netOk, type NetResult } from '@shared/net'
import type {
  LovePayload,
  NowPlayingPayload,
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
import { missingAppKeyMessage, resolveLastfmAppKey, type AppKeySettingsSource } from './appKey'
import { LASTFM_ERROR, type LastfmTransport } from './transport'

/** Where the operator is sent to approve the token. */
export const LASTFM_AUTH_PAGE = 'https://www.last.fm/api/auth/'

/**
 * Last.fm's published ceiling, and the reason `capabilities.batchLimit` exists.
 *
 * Declared on the target rather than known by the drain worker — the number is a
 * fact about this service, and W11-8's is different.
 */
export const LASTFM_BATCH_LIMIT = 50

/**
 * How often to ask whether the operator has approved the token.
 *
 * Three seconds is under the threshold at which a person who has just clicked
 * "Yes, allow access" notices that nothing happened, and it is far enough above
 * the per-host limiter's 1.1s that polling never becomes the thing being waited
 * on.
 */
export const LASTFM_AUTH_POLL_INTERVAL_MS = 3_000

/**
 * How long to keep asking. Five minutes is a generous sign-in — finding a
 * password, a second factor, a browser that had to be opened first — and short
 * of the point where a forgotten tab has an app quietly polling all afternoon.
 */
export const LASTFM_AUTH_TIMEOUT_MS = 5 * 60_000

const CAPABILITIES: ScrobbleTargetCapabilities = {
  batchLimit: LASTFM_BATCH_LIMIT,
  supportsLove: true,
  // Last.fm accepts a scrobble with no duration; it simply cannot apply its own
  // half-way rule to one. Fermata has already applied its own by the time a row
  // is enqueued, so a missing duration is a slightly poorer scrobble rather than
  // an unsendable one.
  requiresDuration: false
}

/**
 * The concrete target, with the one method the contract has no room for.
 *
 * `ScrobbleTarget.authorize()` takes no cancellation, because a general
 * "abandon this" belongs to the net scope and every other call is short. A
 * browser round trip is the exception: it is minutes long by design, and the
 * operator who abandons it needs a way to say so that does not also cancel a
 * drain in flight. `StubScrobbleTarget` widens the interface for its own reason;
 * this is the same move.
 */
export interface LastfmScrobbleTarget extends ScrobbleTarget {
  readonly id: 'lastfm'
  /** Abandon a sign-in in progress. Idempotent, and a no-op when none is. */
  cancelAuthorize(): void
}

export interface LastfmTargetOptions {
  transport: LastfmTransport
  credentials: ScrobbleCredentialStore
  settings: AppKeySettingsSource
  /** `shell.openExternal`, injected so a test never launches a browser. */
  openExternal: (url: string) => Promise<void>
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>
  /** Injected so tests can drive the deadline. */
  now?: () => number
  pollIntervalMs?: number
  timeoutMs?: number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as { unref?: () => void }).unref?.()
  })

/** `auth.getToken`'s answer. */
interface TokenBody {
  token?: unknown
}

/** `auth.getSession`'s answer: a session object, not a bare key. */
interface SessionBody {
  session?: { name?: unknown; key?: unknown }
}

const NOT_CONNECTED: ScrobbleConnection = { target: 'lastfm', connected: false, username: null }

export function createLastfmTarget({
  transport,
  credentials,
  settings,
  openExternal,
  sleep = defaultSleep,
  now = Date.now,
  pollIntervalMs = LASTFM_AUTH_POLL_INTERVAL_MS,
  timeoutMs = LASTFM_AUTH_TIMEOUT_MS
}: LastfmTargetOptions): LastfmScrobbleTarget {
  /**
   * The credential, cached after the first read.
   *
   * `connection()` is called in the drain worker's per-batch guard, and the read
   * behind it decrypts a file. `undefined` means "not looked at yet";
   * `null` means "looked, and there is none". Both `authorize` and `disconnect`
   * write through, so the cache cannot outlive the truth.
   */
  let cached: ScrobbleCredential | null | undefined

  const current = (): ScrobbleCredential | null => {
    if (cached === undefined) cached = credentials.read('lastfm')
    return cached
  }

  const connection = (): ScrobbleConnection => {
    const credential = current()
    return credential === null
      ? NOT_CONNECTED
      : { target: 'lastfm', connected: true, username: credential.username }
  }

  /**
   * Set when a sign-in is in progress, so a second Connect click joins the
   * flow rather than starting a competing one — two tokens in two browser tabs
   * is a way to make the first one look broken.
   */
  let pending: { cancelled: boolean } | null = null

  const notImplemented = (method: string): NetResult<never> =>
    netFailed({
      kind: 'rejected',
      message: `Fermata cannot send ${method} to Last.fm yet (W11-4).`
    })

  return {
    id: 'lastfm',
    capabilities: CAPABILITIES,
    connection,

    cancelAuthorize: (): void => {
      if (pending !== null) pending.cancelled = true
    },

    async authorize(): Promise<NetResult<ScrobbleConnection>> {
      if (pending !== null) {
        return netFailed({
          kind: 'rejected',
          message: 'A Last.fm sign-in is already waiting in your browser.'
        })
      }

      const appKey = resolveLastfmAppKey(settings)
      if (appKey === null) {
        return netFailed({ kind: 'declined', message: missingAppKeyMessage(settings) })
      }

      // Checked before the browser opens, not after the operator has signed in.
      // Discovering that the credential cannot be stored *after* someone has
      // typed their password is the same amount of broken delivered as rudely as
      // possible.
      if (!credentials.available()) {
        return netFailed({
          kind: 'declined',
          message: new CredentialSealingUnavailableError().message
        })
      }

      const flow = { cancelled: false }
      pending = flow
      try {
        const token = await transport.call<TokenBody>({
          method: 'auth.getToken',
          api_key: appKey.apiKey
        })
        if (!token.ok) return netFailed(token.failure)
        if (typeof token.value.token !== 'string' || token.value.token === '') {
          return netFailed({ kind: 'malformed', message: 'Last.fm sent an unreadable token.' })
        }
        const requestToken = token.value.token

        const page = new URL(LASTFM_AUTH_PAGE)
        page.searchParams.set('api_key', appKey.apiKey)
        page.searchParams.set('token', requestToken)
        try {
          await openExternal(page.toString())
        } catch {
          return netFailed({
            kind: 'rejected',
            message: 'Fermata could not open your browser to sign in to Last.fm.'
          })
        }

        const deadline = now() + timeoutMs
        for (;;) {
          await sleep(pollIntervalMs)
          if (flow.cancelled) {
            return netFailed({ kind: 'cancelled', message: 'The Last.fm sign-in was cancelled.' })
          }

          const session = await transport.call<SessionBody>({
            method: 'auth.getSession',
            api_key: appKey.apiKey,
            token: requestToken
          })

          if (session.ok) {
            const name = session.value.session?.name
            const key = session.value.session?.key
            if (typeof name !== 'string' || typeof key !== 'string' || key === '') {
              return netFailed({
                kind: 'malformed',
                message: 'Last.fm sent an unreadable sign-in reply.'
              })
            }
            const credential: ScrobbleCredential = { username: name, secret: key }
            try {
              credentials.write('lastfm', credential)
            } catch (err) {
              // The keyring was available at the top of this function and is not
              // now — rare, but the alternative to handling it is holding a
              // session key in memory that vanishes at quit while the pane says
              // "connected".
              return netFailed({
                kind: 'declined',
                message:
                  err instanceof CredentialSealingUnavailableError
                    ? err.message
                    : 'Fermata could not save the Last.fm sign-in.'
              })
            }
            cached = credential
            return netOk(connection())
          }

          // The only answer that means "keep waiting". Every other failure is
          // either terminal or worth surfacing now rather than in five minutes.
          if (session.code !== LASTFM_ERROR.unauthorizedToken) return netFailed(session.failure)

          if (now() >= deadline) {
            return netFailed({
              kind: 'timeout',
              message:
                'Last.fm did not report a completed sign-in. If you approved it in your ' +
                'browser, try connecting again.'
            })
          }
        }
      } finally {
        pending = null
      }
    },

    async disconnect(): Promise<void> {
      if (pending !== null) pending.cancelled = true
      credentials.clear('lastfm')
      cached = null
    },

    // Fire-and-forget by contract, and there is nothing to fire yet. It returns
    // rather than failing because a caller is forbidden from acting on the
    // outcome either way — see `ScrobbleTarget.nowPlaying`. W11-4.
    async nowPlaying(_payload: NowPlayingPayload): Promise<void> {
      void _payload
    },

    async submit(
      _batch: readonly ScrobbleSubmission[]
    ): Promise<NetResult<ScrobbleSubmissionResult[]>> {
      void _batch
      return notImplemented('scrobbles')
    },

    async love(_payload: LovePayload): Promise<NetResult<void>> {
      void _payload
      return notImplemented('loves')
    },

    async unlove(_payload: LovePayload): Promise<NetResult<void>> {
      void _payload
      return notImplemented('loves')
    }
  }
}
