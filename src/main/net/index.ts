/**
 * Fermata's outbound network layer, assembled.
 *
 * One client, one scope registry and one limiter per process. The limiter in
 * particular must be a singleton or it is not a limiter: two instances spacing
 * their own requests a second apart still put two requests a second on
 * MusicBrainz, which is precisely the ceiling R5 says we must stay under.
 */

import { NETWORK_EXTERNAL_LOOKUPS_KEY } from '@shared/settings'
import type { CancelNetScopeResult, NetScope } from '@shared/net'
import { createNetClient, type NetClient } from './client'
import { createNetworkConsent, type ConsentSettingsSource } from './consent'
import { createRateLimiter, type RateLimiter } from './rateLimiter'
import { createScopeRegistry, type ScopeRegistry } from './scopes'

export {
  createNetClient,
  type NetClient,
  type NetClientOptions,
  type NetGetRequest,
  type NetPostRequest
} from './client'
export {
  createNetworkConsent,
  CONSENT_DENIED,
  CONSENT_GRANTED,
  type NetworkConsent
} from './consent'
export { createRateLimiter, type RateLimiter } from './rateLimiter'
export {
  createScopeRegistry,
  RequestTimeoutError,
  ScopeCancelledError,
  type ScopeRegistry
} from './scopes'
export { OSCINE_USER_AGENT } from './userAgent'
export { NETWORK_EXTERNAL_LOOKUPS_KEY }

/**
 * MusicBrainz's published ceiling is one request per second. 1100ms rather than
 * 1000: the limit is enforced on their side against arrival times, and a client
 * that aims exactly at the line lands over it whenever the network is kind.
 */
export const METADATA_MIN_INTERVAL_MS = 1_100

export interface NetService {
  readonly client: NetClient
  readonly scopes: ScopeRegistry
  /**
   * The process's one limiter, exposed so that a second client can share it.
   *
   * Only D19's scrobble transport needs one, and it needs one because the
   * consent gate is baked into a client at construction — see
   * `scrobble/lastfm/transport.ts`. Sharing this instance rather than making a
   * second is not a tidiness point: the limiter spaces per host, and two
   * instances would each honour a ceiling the pair of them together broke.
   */
  readonly limiter: RateLimiter
  cancelScope(scope: NetScope): CancelNetScopeResult
}

export function createNetService(settings: ConsentSettingsSource): NetService {
  const scopes = createScopeRegistry()
  const limiter = createRateLimiter({ minIntervalMs: METADATA_MIN_INTERVAL_MS })
  const client = createNetClient({
    consent: createNetworkConsent(settings),
    limiter,
    scopes
  })

  return {
    client,
    scopes,
    limiter,
    cancelScope: (scope) => ({ cancelled: scopes.cancel(scope) })
  }
}
