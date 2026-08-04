/**
 * What the settings pane is told, assembled in one place.
 *
 * Two sources have to agree before a status line is honest — the targets know
 * who is connected, the outbox knows how many rows are waiting and why the last
 * attempt failed — and neither can see the other. This module is the seam, and
 * it exists so that there is exactly one answer to "what does the renderer
 * currently see", rather than an IPC handler and a broadcaster that each compose
 * the same reads and drift.
 *
 * Whether a target is *paused* is not assembled here: `lastfm.enabled` is an
 * ordinary durable setting and the renderer reads it from W8's store, for the
 * reason given in `@shared/scrobble`.
 *
 * ## Why it is not on `ScrobbleAccountsService`
 *
 * Accounts owns the targets and nothing else; giving it a database handle to
 * answer a question about the queue would make the one object that enforces
 * D19's rule also the object that knows the most. The rule is easiest to keep
 * when the thing enforcing it stays small enough to read in one sitting.
 *
 * ## What it deliberately cannot return
 *
 * A credential. Everything here is a `ScrobbleTargetStatus`, which is a target
 * id, a boolean, a username, a count and a sentence main already wrote — see
 * `@shared/scrobble`. There is no method that takes a target and returns the
 * thing that authenticates it, because a method that could would eventually be
 * called by a handler that meant well.
 */

import type { ScrobbleStatusResult, ScrobbleTargetStatus } from '@shared/scrobble'
import type { ScrobbleAccountsService } from './accounts'
import type { ScrobbleDrainWorker } from './drain'
import type { ScrobbleOutbox } from './outbox'

export interface ScrobbleStatusOptions {
  readonly accounts: ScrobbleAccountsService
  readonly outbox: ScrobbleOutbox
  readonly drain: ScrobbleDrainWorker
}

export interface ScrobbleStatusService {
  /** Every target this build has, with its queue reading. Cheap: two indexed reads each. */
  status(): ScrobbleStatusResult
  /**
   * Wake the drain and report what it left behind.
   *
   * Resolves after the pass rather than at the start of it, so the count the
   * caller returns to the pane is the one the operator is about to be shown —
   * a retry that answered with the pre-drain depth would look like a button
   * that did nothing.
   */
  retry(): Promise<ScrobbleStatusResult>
}

export function createScrobbleStatusService({
  accounts,
  outbox,
  drain
}: ScrobbleStatusOptions): ScrobbleStatusService {
  const status = (): ScrobbleStatusResult => ({
    targets: accounts.connections().map((connection): ScrobbleTargetStatus => ({
      ...connection,
      queueDepth: outbox.depth(connection.target),
      // Read whether or not the target is connected. A queue that stopped
      // draining because the session was refused is exactly the case where
      // the reason matters most, and it is also the case where `connected`
      // has just gone false.
      lastError: outbox.lastError(connection.target)
    }))
  })

  return {
    status,

    async retry(): Promise<ScrobbleStatusResult> {
      // The report is discarded on purpose: it says what one pass did, and the
      // pane asks a different question — what is left. Reading the outbox after
      // the pass answers that without the caller having to reconcile a report
      // against a count.
      await drain.wake()
      return status()
    }
  }
}
