/**
 * **D14**'s first rule, at the socket.
 *
 * The gate is here rather than in the panes that want the data, for the same
 * reason the filesystem is not in the renderer: a rule enforced at the point of
 * *display* is a rule that a new caller can forget, and forgetting this one
 * means a request left the machine. Every path in `src/main/net` asks this
 * before it opens anything, so consent is checked once per request by
 * construction and no pane has to remember.
 *
 * ## It is read live, never cached
 *
 * `granted()` resolves the setting on every call. That costs a registry walk
 * per request — irrelevant against a limiter that already spaces requests a
 * second apart — and it buys the card's "re-enabling takes effect without a
 * restart" for free, with no invalidation to get wrong. A cached copy would
 * need a `settings.changed` subscription, and the failure mode of getting that
 * subscription wrong is a machine that keeps fetching after being told to stop.
 * That asymmetry is the whole argument: the expensive answer is the safe one.
 *
 * It is also checked *between* retries rather than only before the first
 * attempt, so switching the toggle off abandons work already in flight instead
 * of letting a backoff schedule outlive the decision.
 */

import { NETWORK_EXTERNAL_LOOKUPS_KEY } from '@shared/settings'
import type { SettingsService } from '../settings'

export interface NetworkConsent {
  /** Whether Fermata may contact a service of its own choosing, right now. */
  granted(): boolean
}

/**
 * Only `getAll` is required, so a test can pass a two-line stand-in rather than
 * a database.
 */
export type ConsentSettingsSource = Pick<SettingsService, 'getAll'>

export function createNetworkConsent(settings: ConsentSettingsSource): NetworkConsent {
  return {
    granted(): boolean {
      // `=== true` rather than a truthiness check: an unknown key resolves to
      // `undefined`, and the one direction this must never fail in is open.
      return settings.getAll().values[NETWORK_EXTERNAL_LOOKUPS_KEY] === true
    }
  }
}

/** A gate that always refuses. The safe stand-in wherever one is not wired yet. */
export const CONSENT_DENIED: NetworkConsent = { granted: () => false }

/**
 * A gate that always allows — for the one caller D19 puts outside this one.
 *
 * Exported deliberately un-generic and deliberately hard to reach for: it is not
 * a convenience for code that has not wired consent yet (that is
 * `CONSENT_DENIED`, above, and the asymmetry is the point). It exists so that
 * scrobbling's exemption is a named thing with an argument attached rather than
 * a second client that quietly forgot to ask.
 *
 * The argument, in full, lives in D19 and at the construction site in
 * `scrobble/lastfm/transport.ts`. In short: this gate covers the lookups
 * *Fermata* decides to make. A scrobble goes to a service the operator signed
 * into, by typing their own password on that service's own login page, having
 * been told what it was for — which is stronger and more specific consent than
 * the checkbox this gate reads, not weaker. Until that sign-in completes there
 * is no credential and nothing outbound happens at all.
 */
export const CONSENT_GRANTED: NetworkConsent = { granted: () => true }
