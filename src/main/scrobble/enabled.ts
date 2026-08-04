/**
 * The pause switch, resolved to a list of targets that may send.
 *
 * Four things send on a target's behalf — the drain worker, the now-playing
 * announcer, the listen commit's enqueue and the loved push — and each one takes
 * its targets through a function. This is that function, and it exists as a
 * module rather than as a closure in `main/index.ts` so that "off means off in
 * all four" is a claim with a test behind it instead of four call sites somebody
 * has to check by eye.
 *
 * ## What it deliberately does not filter
 *
 * The accounts service still gets the unfiltered array. A paused target has to
 * remain visible in the settings pane — it is where the switch that unpauses it
 * lives — and a target that vanished from the pane when switched off would be a
 * one-way door.
 *
 * ## The absent-key case is *on*
 *
 * A target with no entry in `SCROBBLE_ENABLED_KEYS` has no switch, and no switch
 * means nothing is holding it back. The alternative — treating a missing key as
 * off, or letting the settings lookup throw for an unregistered key — turns a
 * registry that has not caught up with a new target into scrobbles that silently
 * never send, which is the failure this whole stream is least able to notice.
 */

import type { ScrobbleTarget, ScrobbleTargetId } from '@shared/scrobble'
import { SCROBBLE_ENABLED_KEYS } from '@shared/settings'

export interface SendingTargetsOptions {
  readonly targets: () => readonly ScrobbleTarget[]
  /**
   * Reads a durable boolean, per call.
   *
   * Never captured: W8 applies a settings write immediately and broadcasts it,
   * so a filter holding the value it saw at startup would be a toggle that
   * needed a restart to mean anything.
   */
  readonly getBoolean: (key: string) => boolean
}

/** Whether this target is switched on. True when it has no switch. */
export function scrobbleTargetEnabled(
  target: ScrobbleTargetId,
  getBoolean: (key: string) => boolean
): boolean {
  const key = SCROBBLE_ENABLED_KEYS[target]
  return key === undefined ? true : getBoolean(key)
}

/** The targets that may send right now. Re-evaluated on every call. */
export function createSendingTargets({
  targets,
  getBoolean
}: SendingTargetsOptions): () => readonly ScrobbleTarget[] {
  return () => targets().filter((target) => scrobbleTargetEnabled(target.id, getBoolean))
}
