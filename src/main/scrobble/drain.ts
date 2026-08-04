/**
 * The drain worker — the sending half of D19's "persist first, submit second".
 *
 * It wakes on enqueue, on network return, on app start and on a timer, and each
 * wake is the same pass: for every connected target, take its due rows oldest
 * first, hand them to the target, delete what was accepted, and push what was
 * not into the future. Nothing here knows what a target is; that is the point of
 * `ScrobbleTarget`, and if a `50` ever appears in this file the abstraction has
 * already failed.
 *
 * ## Three failure classes, three behaviours
 *
 * - **Retryable** — offline, timeout, rate-limited, a bad ten minutes at the
 *   service. The rows back off with jitter and the target's drain stops for this
 *   pass, because the next batch is going to fail the same way.
 * - **Terminal for the account** — the stored credential is no longer valid. The
 *   target disconnects *itself* before returning (see `ScrobbleTarget`), so this
 *   worker needs no special failure kind: it re-reads `connection()` after a
 *   failure and, if the target has stood down, records the error and stops
 *   without spending an attempt on every queued row. Burning attempts here would
 *   spend the backoff budget on a condition only the operator can clear.
 * - **Terminal for the row** — `accepted: false`. The service will never take
 *   this payload, so the row is deleted with its reason reported. Retrying it
 *   forever is an outbox that never drains.
 *
 * ## Cancellation costs a retry, never a scrobble
 *
 * Targets enrol their requests in the `'scrobble'` net scope, so quitting or
 * signing out aborts the batch in flight and `submit` comes back `cancelled`.
 * That is not a failure of the rows: nothing is written, no attempt is counted,
 * and the next pass finds the queue exactly as it was. `declined` is treated the
 * same way — no socket was opened, so there is nothing to hold the rows
 * responsible for.
 *
 * ## Scrobbles and loves drain apart
 *
 * `submit` batches; `love` and `unlove` do not, and they are order-sensitive in
 * a way scrobbles are not — heart, un-heart, heart again must not arrive as
 * un-heart last (W11-6). Draining them as two streams keeps loves strictly
 * sequential without letting a love row split a scrobble batch in half, and the
 * two have no ordering relationship with each other to preserve.
 */

import type { NetFailure } from '@shared/net'
import type { ScrobbleTarget, ScrobbleTargetId } from '@shared/scrobble'
import { backoffDelayMs } from './backoff'
import type { ScrobbleOutbox, ScrobbleQueueKind, ScrobbleQueueRow } from './outbox'

/** Why a target's pass ended. */
export type ScrobbleDrainStop =
  /** Nothing left that is due. The ordinary ending. */
  | 'drained'
  /** The target is not connected — either before the pass, or it stood down mid-pass. */
  | 'disconnected'
  /** The scope was cancelled, or consent was withheld. No row was touched. */
  | 'cancelled'
  /** A retryable failure. The batch backed off and the pass stopped. */
  | 'deferred'
  /** Something threw. The rows are untouched and the error is on the report. */
  | 'errored'

/** A row the service will never accept, on its way out of the queue. */
export interface ScrobbleDrop {
  readonly id: number
  readonly target: ScrobbleTargetId
  readonly kind: ScrobbleQueueKind
  readonly reason: string
}

export interface ScrobbleTargetDrainReport {
  readonly target: ScrobbleTargetId
  /** Rows a target accepted and that are now gone from the queue. */
  readonly sent: number
  /**
   * Rows dropped as unsendable, with the service's reason.
   *
   * Reported rather than left in `last_error`, because the row that would carry
   * it is the row being deleted. A drop is the one outcome that costs the
   * operator a scrobble, so it travels back to the caller instead of vanishing
   * into a table with no rows in it.
   */
  readonly dropped: readonly ScrobbleDrop[]
  /** Rows pushed into the future to be tried again. */
  readonly deferred: number
  readonly stop: ScrobbleDrainStop
  /** The failure that ended the pass, when one did. */
  readonly failure?: NetFailure
  /** Set only when `stop` is `'errored'`. */
  readonly error?: unknown
}

export interface ScrobbleDrainReport {
  readonly targets: readonly ScrobbleTargetDrainReport[]
}

export interface ScrobbleDrainWorkerOptions {
  readonly outbox: ScrobbleOutbox
  /**
   * Read fresh on every pass, not captured once.
   *
   * Connecting an account (W11-3) and disconnecting one are ordinary operator
   * gestures that happen while the worker is alive, and a worker holding a stale
   * array would keep draining to a target the operator has just signed out of.
   */
  readonly targets: () => readonly ScrobbleTarget[]
  readonly now?: () => number
  readonly random?: () => number
  /** The backstop wake. See `DEFAULT_DRAIN_INTERVAL_MS`. */
  readonly intervalMs?: number
  /** How many love/unlove rows one pass will walk. */
  readonly loveLimit?: number
}

export interface ScrobbleDrainWorker {
  /**
   * Drain now, coalescing with a pass already running.
   *
   * Never rejects: a pass that throws reports `'errored'` for the target that
   * threw and carries on with the rest, because one target's broken statement
   * must not stop the other's scrobbles from being sent.
   */
  wake(): Promise<ScrobbleDrainReport>
  /** Begin the timer. Idempotent. */
  start(): void
  /** Stop the timer. Does not abandon a pass in flight — the scope does that. */
  stop(): void
}

/**
 * Five minutes.
 *
 * The timer is a backstop, not the mechanism: enqueue, app start and network
 * return all wake the worker directly, and this only catches the case where a
 * row became due with nothing to announce it — a machine that resumed from
 * sleep with the network already up, say. Cheap enough at this interval to be
 * worth having (one indexed count per target) and slow enough that an operator
 * never notices it.
 */
export const DEFAULT_DRAIN_INTERVAL_MS = 5 * 60 * 1000

/** How many loves one pass walks. Generous; loves arrive one gesture at a time. */
const DEFAULT_LOVE_LIMIT = 100

const LOVE_KINDS: readonly ScrobbleQueueKind[] = ['love', 'unlove']

/**
 * Failures that are about the request never having been made, rather than about
 * the rows. Neither costs an attempt.
 */
function isCostFree(failure: NetFailure): boolean {
  return failure.kind === 'cancelled' || failure.kind === 'declined'
}

export function createScrobbleDrainWorker(
  options: ScrobbleDrainWorkerOptions
): ScrobbleDrainWorker {
  const { outbox } = options
  const now = options.now ?? ((): number => Date.now())
  const random = options.random ?? Math.random
  const intervalMs = options.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS
  const loveLimit = options.loveLimit ?? DEFAULT_LOVE_LIMIT

  let running: Promise<ScrobbleDrainReport> | null = null
  let pending = false
  let timer: ReturnType<typeof setInterval> | null = null

  /** Accumulates one target's pass so the failure handlers can add to it. */
  interface Pass {
    sent: number
    deferred: number
    dropped: ScrobbleDrop[]
    stop: ScrobbleDrainStop
    failure?: NetFailure
  }

  function reschedule(rows: readonly ScrobbleQueueRow[], failure: NetFailure, pass: Pass): void {
    const at = now()
    outbox.reschedule(
      rows.map((row) => ({
        id: row.id,
        // The row's own attempt count, not the batch's: a scrobble queued this
        // morning and one queued last week can share a batch, and giving the
        // new row the old one's delay would park it for six hours over a blip
        // it has not yet met.
        nextAttemptAt:
          at +
          backoffDelayMs({
            attempts: row.attempts,
            retryAfterSeconds: failure.retryAfterSeconds,
            random
          })
      })),
      failure.message
    )
    pass.deferred += rows.length
  }

  /**
   * Apply a failed `NetResult` to the rows it was carrying, and say whether the
   * target's pass can continue. It never can — every failure here is either
   * about the network or about the account, and both mean the next batch fails
   * identically — but returning the stop reason keeps that decision in one place.
   */
  function applyFailure(
    target: ScrobbleTarget,
    rows: readonly ScrobbleQueueRow[],
    failure: NetFailure,
    pass: Pass
  ): void {
    pass.failure = failure

    if (isCostFree(failure)) {
      pass.stop = 'cancelled'
      return
    }

    // Re-read rather than infer: the contract has the target disconnect itself
    // when its credential is refused, precisely so that this worker needs no
    // knowledge of any service's error codes to recognise the case.
    if (!target.connection().connected) {
      outbox.noteError(
        rows.map((row) => row.id),
        failure.message
      )
      pass.stop = 'disconnected'
      return
    }

    reschedule(rows, failure, pass)
    pass.stop = 'deferred'
  }

  async function drainScrobbles(target: ScrobbleTarget, pass: Pass): Promise<void> {
    const batchLimit = Math.max(1, Math.trunc(target.capabilities.batchLimit))

    for (;;) {
      const rows = outbox.ready({
        target: target.id,
        kinds: ['scrobble'],
        limit: batchLimit,
        now: now()
      })
      if (rows.length === 0) return

      const result = await target.submit(rows.map((row) => ({ id: row.id, payload: row.payload })))

      if (!result.ok) {
        applyFailure(target, rows, result.failure, pass)
        return
      }

      const queued = new Map(rows.map((row) => [row.id, row]))
      const answered = new Set<number>()
      const finished: number[] = []

      for (const item of result.value) {
        // Ids we did not send, and second answers for one we did, are both a
        // target misbehaving. Ignoring them is safe; acting on them would mean
        // deleting a row on the strength of a number the service made up.
        const row = queued.get(item.id)
        if (row === undefined || answered.has(item.id)) continue
        answered.add(item.id)
        finished.push(item.id)

        if (item.accepted) {
          pass.sent += 1
        } else {
          pass.dropped.push({
            id: row.id,
            target: target.id,
            kind: row.kind,
            reason: item.reason
          })
        }
      }

      outbox.delete(finished)

      // A result short of one answer per submission is out of contract, and the
      // only safe reading is that we do not know what happened to those rows.
      // Backing them off retries them; assuming success would lose them.
      const unanswered = rows.filter((row) => !answered.has(row.id))
      if (unanswered.length > 0) {
        reschedule(
          unanswered,
          {
            kind: 'malformed',
            message: 'The service did not say what became of this scrobble.'
          },
          pass
        )
      }
    }
  }

  async function drainLoves(target: ScrobbleTarget, pass: Pass): Promise<void> {
    const rows = outbox.ready({
      target: target.id,
      kinds: LOVE_KINDS,
      limit: loveLimit,
      now: now()
    })
    if (rows.length === 0) return

    // A target with no loves should never have been given love rows (W11-6
    // checks `supportsLove` before enqueueing). If it has some anyway, they can
    // never drain, and a row that can never drain is exactly the thing this
    // whole card exists to prevent — so they go, with a reason.
    if (!target.capabilities.supportsLove) {
      for (const row of rows) {
        pass.dropped.push({
          id: row.id,
          target: target.id,
          kind: row.kind,
          reason: 'This service has no loves to record.'
        })
      }
      outbox.delete(rows.map((row) => row.id))
      return
    }

    for (const row of rows) {
      const payload = { artistName: row.payload.artistName, title: row.payload.title }
      const result = row.kind === 'love' ? await target.love(payload) : await target.unlove(payload)

      if (!result.ok) {
        // Terminal for the row, and only for the row: a 4xx no amount of
        // retrying fixes is `submit`'s error-6 case wearing the one-at-a-time
        // shape loves have. Left to back off it would be worse here than there,
        // because the stream stops at the first failure — so one unsendable love
        // would wedge every later one behind it forever, which is precisely the
        // outbox-that-never-drains this whole design is arranged against.
        //
        // Ordering survives it. The row is gone rather than skipped, so no later
        // toggle for that track overtakes an earlier one that is still waiting;
        // the remaining flips apply in sequence and the account settles on the
        // last of them.
        //
        // The connection check comes first because `rejected` is also what a
        // target answers when it has no credential, and a target that signed out
        // between the guard above and this row has not refused the love — it has
        // not sent it. Dropping it then would lose a heart to a race.
        if (result.failure.kind === 'rejected' && target.connection().connected) {
          pass.dropped.push({
            id: row.id,
            target: target.id,
            kind: row.kind,
            reason: result.failure.message
          })
          outbox.delete([row.id])
          continue
        }

        // Everything else stops the whole stream, not just this row. Skipping
        // ahead to the next love would send a later toggle for the same track
        // before an earlier one, and the account would settle in the wrong state.
        applyFailure(target, [row], result.failure, pass)
        return
      }

      outbox.delete([row.id])
      pass.sent += 1
    }
  }

  async function drainTarget(target: ScrobbleTarget): Promise<ScrobbleTargetDrainReport> {
    const pass: Pass = { sent: 0, deferred: 0, dropped: [], stop: 'drained' }

    if (!target.connection().connected) {
      return { target: target.id, sent: 0, dropped: [], deferred: 0, stop: 'disconnected' }
    }

    try {
      await drainScrobbles(target, pass)
      if (pass.stop === 'drained') await drainLoves(target, pass)
    } catch (error) {
      return {
        target: target.id,
        sent: pass.sent,
        dropped: pass.dropped,
        deferred: pass.deferred,
        stop: 'errored',
        error
      }
    }

    return {
      target: target.id,
      sent: pass.sent,
      dropped: pass.dropped,
      deferred: pass.deferred,
      stop: pass.stop,
      ...(pass.failure === undefined ? {} : { failure: pass.failure })
    }
  }

  async function drainOnce(): Promise<ScrobbleDrainReport> {
    const targets: ScrobbleTargetDrainReport[] = []
    // Sequentially, so two targets never contend for the same SQLite write
    // transaction — and because they are independent, a slow one delaying a fast
    // one costs nothing an operator can perceive.
    for (const target of options.targets()) {
      targets.push(await drainTarget(target))
    }
    return { targets }
  }

  function wake(): Promise<ScrobbleDrainReport> {
    // A wake arriving mid-pass schedules exactly one more pass rather than
    // queueing one per wake: five listens committed in a minute should cost one
    // extra drain, not five, and the rows are in the table either way.
    if (running !== null) {
      pending = true
      return running
    }

    pending = false
    running = (async (): Promise<ScrobbleDrainReport> => {
      try {
        let report = await drainOnce()
        while (pending) {
          pending = false
          report = await drainOnce()
        }
        return report
      } finally {
        running = null
      }
    })()

    return running
  }

  return {
    wake,
    start(): void {
      if (timer !== null) return
      timer = setInterval(() => {
        void wake()
      }, intervalMs)
      // Never the reason the process stays alive: quitting should not have to
      // wait out a five-minute backstop.
      timer.unref?.()
    },
    stop(): void {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
  }
}
