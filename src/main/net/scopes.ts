/**
 * Cancellation grouped by the thing the operator has open.
 *
 * D14 scopes fetching to an open drawer. That is a statement about *starting*
 * requests, and on its own it leaves the other half unsaid: what happens to the
 * eight requests already in flight when the drawer closes. Ignoring their
 * replies would satisfy the letter of it and waste the socket, the bandwidth
 * and — the part that matters for R5 — the rate-limit slots that the next open
 * then has to wait behind.
 *
 * So every request enrols in a scope, and closing the scope aborts all of them.
 * Queued-but-unstarted work is aborted by the same signal, which is what makes
 * a fast open/close/open cycle cost nothing: the second open finds an empty
 * queue rather than the first open's backlog.
 *
 * ## Distinguishing why a request stopped
 *
 * The scope aborts with a `ScopeCancelledError` and a deadline aborts with a
 * `RequestTimeoutError`, and the client keeps them separable by giving each
 * attempt its own controller that forwards whichever fired. The caller needs the
 * difference: a cancelled scope is silence in the UI, a timeout is something to
 * tell the operator about.
 */

import type { NetScope } from '@shared/net'

/** The reason a scope's requests are aborted with. */
export class ScopeCancelledError extends Error {
  constructor(readonly scope: NetScope) {
    super(`The ${scope} scope was closed.`)
    this.name = 'ScopeCancelledError'
  }
}

/** The reason a single attempt is aborted with when its deadline passes. */
export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`No reply within ${timeoutMs}ms.`)
    this.name = 'RequestTimeoutError'
  }
}

export interface ScopedRequest {
  /** Aborted when the scope is cancelled. Outlives one attempt; retries share it. */
  readonly signal: AbortSignal
  /** Leave the scope. Idempotent, and safe to call from a `finally`. */
  release(): void
}

export interface ScopeRegistry {
  /** Enrol a request. Returns already-aborted if the scope is mid-cancel. */
  enter(scope: NetScope): ScopedRequest
  /** Abort everything in a scope. Returns how many requests were abandoned. */
  cancel(scope: NetScope): number
  /** How many requests are enrolled. Test and diagnostic use only. */
  size(scope: NetScope): number
}

export function createScopeRegistry(): ScopeRegistry {
  const scopes = new Map<NetScope, Set<AbortController>>()

  return {
    enter(scope): ScopedRequest {
      const controller = new AbortController()
      let members = scopes.get(scope)
      if (!members) {
        members = new Set()
        scopes.set(scope, members)
      }
      members.add(controller)

      const release = (): void => {
        const current = scopes.get(scope)
        if (!current) return
        current.delete(controller)
        if (current.size === 0) scopes.delete(scope)
      }

      return { signal: controller.signal, release }
    },

    cancel(scope): number {
      const members = scopes.get(scope)
      if (!members) return 0
      // Snapshot first: aborting runs listeners synchronously, and a listener
      // that releases its request would otherwise mutate the set being walked.
      const controllers = [...members]
      scopes.delete(scope)
      for (const controller of controllers) {
        controller.abort(new ScopeCancelledError(scope))
      }
      return controllers.length
    },

    size(scope): number {
      return scopes.get(scope)?.size ?? 0
    }
  }
}
