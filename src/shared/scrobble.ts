import type { NetResult } from './net'

/**
 * The scrobbling provider contract — **D19**.
 *
 * Every target implements `ScrobbleTarget`, and nothing above it knows how any
 * particular service authenticates or signs. That is the whole job of this
 * file: Last.fm's `md5(sorted params + shared secret)` signature, its
 * array-indexed batch parameters and its numeric error codes are facts about
 * one implementation, and the moment any of them is visible to the outbox, the
 * threshold logic or a pane, the abstraction has already failed. ListenBrainz
 * (W11-8) has no app key, no signature and a different batch limit, and it is
 * in the plan precisely to prove that claim rather than assert it.
 *
 * ## Why it speaks `NetResult`
 *
 * Failures are `NetResult<T>` and `NetFailure` from `./net`, not a scrobbling
 * failure vocabulary. Offline, timeout, rate-limited and 5xx are exactly the
 * states a scrobbler hits, they are already modelled, and a second enumeration
 * would be two things to map between forever — with the mapping table living in
 * whichever layer noticed last.
 *
 * ## Why the renderer does not see this
 *
 * `src/shared` is the cross-process contract, but "shared" is about *one*
 * definition, not about who may call it. This interface is implemented and
 * called in main only. The credential never crosses IPC (D19), so the
 * renderer-facing surface (W11-7) is deliberately narrower: it is
 * `ScrobbleConnection` and a queue depth, and that is all.
 */

/**
 * The targets this build knows how to speak to.
 *
 * A closed list for `NET_SCOPES`' reason: the outbox stores this string in
 * `scrobble_queue.target`, and a row naming a target no build can construct is
 * a row that never drains and never explains itself. Adding a target is a
 * decision — an auth model, a batch limit, a set of required fields — not a
 * spelling.
 */
export const SCROBBLE_TARGET_IDS = ['lastfm', 'listenbrainz'] as const

export type ScrobbleTargetId = (typeof SCROBBLE_TARGET_IDS)[number]

/**
 * What one listen carries on the wire.
 *
 * These are the snapshot columns of `scrobble_queue` (migration 012, W11-2) and
 * they are snapshots on purpose: the queue must still be able to send after the
 * track has left the library, which is exactly the case where the rescan that
 * removed it and the network coming back are the same afternoon.
 */
export interface ScrobblePayload {
  readonly artistName: string
  readonly title: string
  readonly albumTitle: string | null
  /**
   * The album's credited artist, when it differs from the track's.
   *
   * Sent when known because it is what makes a compilation resolve to one
   * release rather than to fourteen artists' discographies.
   */
  readonly albumArtistName: string | null
  /**
   * Track length in **seconds**, or `null` when the library does not know it.
   *
   * Seconds rather than the milliseconds the rest of Oscine counts in, because
   * this is a wire field and every target defines it in seconds. Converting at
   * the boundary once is cheaper than a unit that means two things.
   *
   * `null` is legal here even for a target whose `requiresDuration` is true —
   * see that flag. The contract's job is to describe the listen; deciding that
   * an incomplete listen cannot be sent belongs to the caller, which is the one
   * that can drop the row and say why.
   */
  readonly durationSeconds: number | null
  /**
   * When the listen *started*, in UTC **seconds** since the epoch.
   *
   * Seconds, not milliseconds: it is Last.fm's field and ListenBrainz's alike,
   * and a millisecond value silently accepted as a seconds value dates the
   * scrobble to the year 56000. The start of the listen rather than its end,
   * because that is what both services define `timestamp` to mean.
   */
  readonly timestamp: number
}

/**
 * What "currently playing" carries — the same listen without a time.
 *
 * There is no timestamp because the payload *is* the claim that this is
 * happening now; the server expires it on its own schedule. It is sent at the
 * transport-commit moment rather than at departure, since announcing a track at
 * the end of it would be announcing the past.
 */
export type NowPlayingPayload = Omit<ScrobblePayload, 'timestamp'>

/** What a love or unlove identifies. Targets key loves by artist and title. */
export interface LovePayload {
  readonly artistName: string
  readonly title: string
}

/**
 * One item of a batch, tagged so its result can be found again.
 *
 * `id` is the outbox row id, and the target's only obligation is to echo it
 * back untouched — it must not order by it, parse it or assume it is dense.
 * Correlating by array position instead would work right up until a target
 * returns results for the items it understood, which is the case this whole
 * per-item design exists for.
 */
export interface ScrobbleSubmission {
  readonly id: number
  readonly payload: ScrobblePayload
}

/**
 * What became of one item, per item and never per batch.
 *
 * Last.fm accepts a batch containing rejects. Collapsing that to a single
 * verdict has one of two failure modes and no third option: call the batch
 * failed and the accepted scrobbles are retried forever, or call it succeeded
 * and the rejected ones are dropped silently. Either way the outbox grows while
 * appearing to work.
 *
 * `accepted: false` is **terminal for that row** — the caller records `reason`
 * in `last_error` and deletes it. It means the service will never take this
 * payload: an unparseable timestamp, an empty artist, a track it refuses to
 * index. A condition that will pass on its own — a daily quota, a throttle, a
 * bad ten minutes at the service — is not a rejection and must not be reported
 * as one; it is a failure of the whole call, so that backoff applies to the
 * batch and nothing is lost.
 */
export type ScrobbleSubmissionResult =
  | { readonly id: number; readonly accepted: true }
  | { readonly id: number; readonly accepted: false; readonly reason: string }

/**
 * What a target can do, so that no caller has to know which target it is.
 *
 * This is the part that keeps the abstraction honest. If the drain worker
 * writes `50` anywhere, it has hardcoded Last.fm and W11-8 becomes a rewrite
 * rather than an implementation — so the number lives here, while there is
 * still only one implementation to be tempted by.
 */
export interface ScrobbleTargetCapabilities {
  /**
   * The most submissions one `submit` call may carry. At least 1.
   *
   * The caller is responsible for the limit; a target handed more than it
   * advertises may fail the whole call as `rejected`, and is not obliged to
   * split it.
   */
  readonly batchLimit: number
  /**
   * Whether `love` and `unlove` do anything.
   *
   * When false, the caller does not enqueue loves for this target at all — it
   * is a target with no opinion about loves, not one that keeps failing to
   * record them.
   */
  readonly supportsLove: boolean
  /**
   * Whether a `null` `durationSeconds` makes a payload unsendable.
   *
   * Declared rather than discovered, so that a listen missing a duration is
   * dropped at enqueue with a reason instead of being submitted, rejected and
   * dropped a round trip later.
   */
  readonly requiresDuration: boolean
}

/**
 * What the operator is told about a target, and the *only* scrobbling fact the
 * renderer ever receives (D19).
 *
 * A username and a boolean. Not a session key, not a token, not an expiry —
 * there is nothing here that a compromised renderer could scrobble with.
 */
export interface ScrobbleConnection {
  readonly target: ScrobbleTargetId
  readonly connected: boolean
  /** The account name, for the settings pane. `null` when not connected. */
  readonly username: string | null
}

/**
 * What the settings pane shows, which is a connection plus the outbox's health.
 *
 * The two extra fields are both readouts of `scrobble_queue` and neither is a
 * credential: a count, and the sentence recorded against the last attempt that
 * failed. They travel with the connection rather than on a channel of their own
 * because the pane draws them on one line — "connected as mdelally, 3 waiting" —
 * and two channels would let those halves disagree for a frame.
 *
 * D19's rule is unchanged by this. Widening what the renderer is told about
 * *the queue* is not widening what it is told about the credential, and the way
 * to keep that distinction from eroding is to state it here, where the next
 * field is about to be added.
 */
export interface ScrobbleTargetStatus extends ScrobbleConnection {
  /**
   * Rows waiting in the outbox for this target, backing off or not.
   *
   * Rows are deleted on acceptance, so this is zero in the steady state and any
   * other number is a direct readout of how long the network has been away. It
   * is a status and not an error — see W11-7 — and the pane styles it as one.
   */
  readonly queueDepth: number
  /**
   * Why the last attempt failed, in the words main already chose, or `null`.
   *
   * Already an operator-facing sentence when it arrives here: the Last.fm
   * transport maps its numeric codes to prose at the boundary, so the pane
   * neither parses nor re-translates. A pane that had to recognise "code 9"
   * would be a second copy of the error taxonomy, in the process least able to
   * keep it current.
   */
  readonly lastError: string | null
}

/**
 * Whether the target is *paused* is deliberately not here.
 *
 * `lastfm.enabled` is an ordinary durable setting, so the renderer already has
 * it — reactively, through W8's store, broadcast on every write. Copying it onto
 * this payload would give the pane two sources for one boolean and a frame in
 * which they disagree, which is the failure mode the queue depth and the
 * username were joined onto one channel to avoid.
 */

/**
 * The renderer-facing surface, in full.
 *
 * Four requests and one event, and every one of them speaks `ScrobbleConnection`
 * or the `ScrobbleTargetStatus` that extends it — a target id, a boolean, a
 * username, a count and a sentence. There is deliberately no channel that
 * returns anything else about a credential, because the way to guarantee a
 * secret does not cross IPC is for no channel to carry one, rather than for
 * every handler to remember not to.
 */
export interface ScrobbleTargetRequest {
  readonly target: ScrobbleTargetId
}

export interface ScrobbleStatusResult {
  readonly targets: readonly ScrobbleTargetStatus[]
}

/**
 * One scrobbling service, as everything above it sees it.
 *
 * ### The target owns its credential's lifecycle
 *
 * Nothing else can, because nothing else is allowed to hold the credential.
 * That has one consequence worth stating outright: when a call fails because
 * the stored credential is no longer valid — Last.fm's code 9 — the target
 * disconnects itself *before* returning, so that `connection()` immediately
 * reports the truth and the drain worker's ordinary "skip disconnected targets"
 * guard stops the retry loop. The caller does not need a special failure kind
 * for re-authorization, and therefore cannot forget to handle one.
 *
 * ### Cancellation
 *
 * Implementations enrol their requests in the `'scrobble'` net scope, so an
 * in-flight drain is abandoned by the same machinery that abandons the
 * Tunedeck's lookups. No method takes a signal: the scope is the unit of
 * interest, and a per-call signal would be a second way to do it.
 */
export interface ScrobbleTarget {
  readonly id: ScrobbleTargetId
  readonly capabilities: ScrobbleTargetCapabilities

  /** The current connection, cheap enough to call in a drain loop's guard. */
  connection(): ScrobbleConnection

  /**
   * Begin whatever flow this target uses, and store the credential it yields.
   *
   * Resolves once the operator has completed the flow — for Last.fm, a round
   * trip through the system browser — with the connection that resulted. The
   * credential itself is not in the return value and never leaves the target.
   */
  authorize(): Promise<NetResult<ScrobbleConnection>>

  /** Forget the stored credential. Idempotent, and never fails outward. */
  disconnect(): Promise<void>

  /**
   * Announce what is playing. Fire-and-forget, and that is a contract.
   *
   * It returns `void` rather than `NetResult` because there is no caller who
   * could act on the failure: the notification is about a moment that has
   * already passed by the time a retry would land, and it is never queued.
   * Implementations swallow their failures — including a rejection — and this
   * method never rejects.
   */
  nowPlaying(payload: NowPlayingPayload): Promise<void>

  /**
   * Send a batch, at most `capabilities.batchLimit` long.
   *
   * A failed `NetResult` means **nothing in the batch was accepted** — the
   * caller backs the whole batch off and retries all of it. A successful one
   * carries exactly one result per submission, in any order.
   */
  submit(batch: readonly ScrobbleSubmission[]): Promise<NetResult<ScrobbleSubmissionResult[]>>

  /** Record a love. Only called when `capabilities.supportsLove`. */
  love(payload: LovePayload): Promise<NetResult<void>>

  /** Withdraw a love. Only called when `capabilities.supportsLove`. */
  unlove(payload: LovePayload): Promise<NetResult<void>>
}
