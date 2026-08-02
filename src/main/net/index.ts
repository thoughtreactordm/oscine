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
import { createRateLimiter } from './rateLimiter'
import { createScopeRegistry, type ScopeRegistry } from './scopes'

export {
  createNetClient,
  type NetClient,
  type NetClientOptions,
  type NetGetRequest
} from './client'
export { createNetworkConsent, CONSENT_DENIED, type NetworkConsent } from './consent'
export { createRateLimiter, type RateLimiter } from './rateLimiter'
export {
  createScopeRegistry,
  RequestTimeoutError,
  ScopeCancelledError,
  type ScopeRegistry
} from './scopes'
export { FERMATA_USER_AGENT } from './userAgent'
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
  cancelScope(scope: NetScope): CancelNetScopeResult
}

export function createNetService(settings: ConsentSettingsSource): NetService {
  const scopes = createScopeRegistry()
  const client = createNetClient({
    consent: createNetworkConsent(settings),
    limiter: createRateLimiter({ minIntervalMs: METADATA_MIN_INTERVAL_MS }),
    scopes
  })

  return {
    client,
    scopes,
    cancelScope: (scope) => ({ cancelled: scopes.cancel(scope) })
  }
}
