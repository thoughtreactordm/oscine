/**
 * What the scrobbling block draws, decided away from the template.
 *
 * The same split as `listeningRows` and `trackWindow`: everything with a rule in
 * it lives here, where it is a function with a test, and the component is left
 * holding IPC calls and markup. The rules are small but each of them is a
 * sentence an operator reads and acts on — "sign in again to send them" is
 * advice, and advice offered in the wrong state is worse than none.
 *
 * Imports `@shared` and nothing else, so it compiles and tests under the node
 * config like every other pure renderer module.
 */

import type { ScrobbleTargetId, ScrobbleTargetStatus } from '@shared/scrobble'

/** Display names, since main only ever names a target by id. */
export const SCROBBLE_TARGET_LABELS: Readonly<Record<ScrobbleTargetId, string>> = Object.freeze({
  lastfm: 'Last.fm',
  listenbrainz: 'ListenBrainz'
})

export interface ScrobblingRow {
  readonly status: ScrobbleTargetStatus
  readonly label: string
  /** The operator has switched this target off. Its queue is frozen, not dropped. */
  readonly paused: boolean
  /** A sign-in failure to show under this target, or `null`. */
  readonly problem: string | null
  /**
   * Whether "Retry now" is worth offering.
   *
   * Three conditions and each removes a button that would do nothing: there is
   * something to send, there is an account to send it to, and the target has not
   * been told to sit still. A retry that woke a worker which then skips this
   * target is motion without effect, and an operator who presses it twice and
   * sees the same number learns to distrust the number.
   */
  readonly canRetry: boolean
  /**
   * Whether to tell the operator that signing in again is what unblocks this.
   *
   * Derived from the pair "queue has rows, nothing is connected" rather than
   * from any service's error code. That pair is exactly what a target which
   * stood itself down after its session was refused looks like — which is why
   * the renderer needs to know nothing about a code 9, and cannot go stale when
   * the taxonomy in main grows a case.
   *
   * Not shown while paused: the operator who switched scrobbling off is being
   * told the truth about why nothing is moving by the pause line, and a second
   * sentence blaming the sign-in would be a wrong diagnosis.
   */
  readonly needsReconnect: boolean
}

/**
 * "3 scrobbles waiting to send".
 *
 * Loves and unloves ride the same outbox and are counted here too, which the
 * wording rounds off deliberately: the operator's question is how much Fermata
 * still owes the service, and "3 scrobbles and loved-track updates" answers it
 * worse. The tooltip in the component says the exact thing.
 */
export function waitingLabel(depth: number): string {
  return `${depth} ${depth === 1 ? 'scrobble' : 'scrobbles'} waiting to send`
}

/**
 * What to say about a disconnect, before it happens.
 *
 * Built here rather than inline so the promise it makes — the queue survives —
 * is stated in one place and tested against the behaviour `scrobble.disconnect`
 * actually implements.
 */
export function disconnectSummary(label: string, queueDepth: number): string {
  const kept =
    queueDepth > 0
      ? `${queueDepth} ${queueDepth === 1 ? 'scrobble stays' : 'scrobbles stay'} queued and will send if you sign back in. `
      : ''
  return (
    `Fermata has forgotten the saved sign-in. ${kept}` +
    `To withdraw Fermata’s access entirely, remove it on ${label}.`
  )
}

export function scrobblingRows(
  targets: readonly ScrobbleTargetStatus[],
  options: {
    readonly paused: (target: ScrobbleTargetId) => boolean
    readonly problem: (target: ScrobbleTargetId) => string | null
  }
): ScrobblingRow[] {
  return targets.map((status) => {
    const paused = options.paused(status.target)
    return {
      status,
      label: SCROBBLE_TARGET_LABELS[status.target],
      paused,
      problem: options.problem(status.target),
      canRetry: status.connected && !paused && status.queueDepth > 0,
      needsReconnect: !status.connected && !paused && status.queueDepth > 0
    }
  })
}
