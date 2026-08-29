/**
 * Which scrobbling accounts are connected, and the only door to connecting one.
 *
 * A thin thing on purpose. It owns the constructed targets, so that main has one
 * object to hand to the IPC layer and — later — to the drain worker, and it is
 * the boundary at which D19's rule about the renderer is enforced: everything
 * that leaves here is a `ScrobbleConnection`, which is a target id, a boolean
 * and a username. There is no method on this service that returns a credential,
 * and that is the point of there being a service rather than a map.
 *
 * ## Targets are constructed, not enumerated
 *
 * `connections()` reports the targets this build has, not every id in
 * `SCROBBLE_TARGET_IDS`. ListenBrainz is in that list because the outbox stores
 * target ids and W11-8 is planned; showing an operator a ListenBrainz row that
 * cannot be connected to would be advertising a feature by way of a broken
 * button.
 */

import type { NetResult } from '@shared/net'
import type {
  ScrobbleAuthorizeInput,
  ScrobbleConnection,
  ScrobbleTarget,
  ScrobbleTargetId
} from '@shared/scrobble'
import type { LastfmScrobbleTarget } from './lastfm/target'

/** A target that can also abandon a sign-in in progress. */
type ConnectableTarget = ScrobbleTarget & Partial<Pick<LastfmScrobbleTarget, 'cancelAuthorize'>>

export interface ScrobbleAccountsService {
  /** Every target this build knows how to speak to, connected or not. */
  connections(): ScrobbleConnection[]
  /**
   * Run a target's sign-in flow. Resolves when it completes, fails, or is
   * abandoned.
   *
   * `input` carries the token a token-flow target (ListenBrainz) is connected
   * with, and is passed to `authorize` untouched — an interactive target
   * (Last.fm) ignores it. The service does not inspect it: the credential is the
   * target's to hold, and reading it here would be the exact widening D19's
   * renderer rule exists to prevent, one process too early.
   */
  connect(
    target: ScrobbleTargetId,
    input?: ScrobbleAuthorizeInput
  ): Promise<NetResult<ScrobbleConnection>>
  /** Abandon a sign-in in progress. Safe to call when none is. */
  cancelConnect(target: ScrobbleTargetId): void
  /** Forget a target's credential. Idempotent. */
  disconnect(target: ScrobbleTargetId): Promise<void>
  /** The target itself, for main-process callers only — W11-5's drain worker. */
  target(id: ScrobbleTargetId): ScrobbleTarget | null
}

export interface ScrobbleAccountsOptions {
  targets: readonly ConnectableTarget[]
  /**
   * Told whenever a connection changes, so the settings pane does not have to
   * poll. Carries connections and nothing else — see the note above.
   */
  onChanged?: (connections: ScrobbleConnection[]) => void
}

export function createScrobbleAccounts({
  targets,
  onChanged
}: ScrobbleAccountsOptions): ScrobbleAccountsService {
  const byId = new Map<ScrobbleTargetId, ConnectableTarget>(
    targets.map((target) => [target.id, target])
  )

  const connections = (): ScrobbleConnection[] =>
    [...byId.values()].map((target) => target.connection())

  const announce = (): void => onChanged?.(connections())

  return {
    connections,

    target: (id) => byId.get(id) ?? null,

    async connect(id, input): Promise<NetResult<ScrobbleConnection>> {
      const target = byId.get(id)
      if (target === undefined) {
        return {
          ok: false,
          failure: { kind: 'rejected', message: `This build cannot connect to ${id}.` }
        }
      }
      const result = await target.authorize(input)
      // Announced on failure as well as on success: an authorize that failed
      // because the stored session key was refused has left the target
      // disconnected, and the pane needs to hear about that just as much.
      announce()
      return result
    },

    cancelConnect(id): void {
      byId.get(id)?.cancelAuthorize?.()
    },

    async disconnect(id): Promise<void> {
      await byId.get(id)?.disconnect()
      announce()
    }
  }
}
