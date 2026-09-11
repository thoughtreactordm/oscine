import type { PresenceSignal } from '@shared/presence'
import type { SettingsChange } from '@shared/settings'
import type { DiscordSettings } from '@shared/settings/discord'
import { buildActivity } from './activity'
import type { DiscordActivity, DiscordClient } from './client'
import type { PresenceSink } from './presenceSink'

/**
 * The presence service — **W20-4**.
 *
 * The brain that joins the two halves: it implements the `PresenceSink` W20-1
 * stubbed (so it is swapped in for `createNoopPresenceSink` at the wiring),
 * consumes the `PresenceSignal` off the `presence.update` channel, runs it
 * through the pure `buildActivity` mapping, and drives the W20-2 `DiscordClient`.
 * It owns the three things the socket and the mapping deliberately do not: the
 * re-throttle to Discord's rate cap, deduping identical activities, and clearing
 * on stop / disable / pause / quit. See `[[oscine-discord-presence]]` D31, R12.
 */

/**
 * Discord rate-limits presence updates (~1 per 15s is the safe figure). The
 * renderer emitter already debounces to transitions plus a heartbeat (W20-1);
 * this is the second line — a leading-plus-trailing coalescing throttle so a
 * burst that still slips through is collapsed to at most the latest state, and
 * the client is never asked to exceed the cap.
 */
export const PRESENCE_MIN_INTERVAL_MS = 15_000

/** The key prefix every Discord setting shares, so a settings change can be recognised without listing each key. */
const DISCORD_KEY_PREFIX = 'discord.'

export interface PresenceServiceDeps {
  /** The socket half (W20-2). Started lazily on the first activity, closed on disable/quit. */
  readonly client: DiscordClient
  /** The resolved Discord settings, read fresh every derivation so a live change takes effect at once. */
  readonly settings: () => DiscordSettings
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number
  readonly setTimeout?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  /** The re-throttle window. Defaults to {@link PRESENCE_MIN_INTERVAL_MS}. */
  readonly minIntervalMs?: number
}

/**
 * A `PresenceSink` with the extra levers main needs: settings changes broadcast
 * over IPC (W8) so `enabled`/`display` re-derive live, and a quit/stop teardown.
 */
export interface PresenceService extends PresenceSink {
  /** Re-derive from the last signal when a `discord.*` setting changes — no need to wait for the next track. */
  onSettingsChanged(changes: readonly SettingsChange[]): void
  /** Clear presence and disconnect — the quit path. Idempotent. */
  stop(): void
}

function sameActivity(a: DiscordActivity | null, b: DiscordActivity | null): boolean {
  // The activities are small plain objects built by one function in a fixed key
  // order, so a structural string compare is exact and cheap; `null` (clear)
  // compares as `'null'`.
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createPresenceService(deps: PresenceServiceDeps): PresenceService {
  const { client } = deps
  const now = deps.now ?? Date.now
  const setTimeoutFn = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle))
  const minIntervalMs = deps.minIntervalMs ?? PRESENCE_MIN_INTERVAL_MS

  let lastSignal: PresenceSignal | null = null
  let lastSentActivity: DiscordActivity | null = null
  let lastSentAt = 0
  let pending: DiscordActivity | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let clientStarted = false

  function cancelTimer(): void {
    if (timer === null) return
    clearTimeoutFn(timer)
    timer = null
  }

  function send(activity: DiscordActivity | null): void {
    client.setActivity(activity)
    lastSentActivity = activity
    lastSentAt = now()
  }

  function onTimer(): void {
    timer = null
    const next = pending
    pending = null
    if (next !== null && !sameActivity(next, lastSentActivity)) send(next)
  }

  function push(activity: DiscordActivity | null): void {
    if (sameActivity(activity, lastSentActivity)) return

    // Taking a card down is urgent and infrequent: flush a clear at once rather
    // than let a stale "Playing" linger up to a whole throttle window, and drop
    // any queued set it supersedes.
    if (activity === null) {
      cancelTimer()
      pending = null
      send(null)
      return
    }

    const elapsed = now() - lastSentAt
    if (timer === null && elapsed >= minIntervalMs) {
      send(activity)
      return
    }
    pending = activity
    if (timer === null) timer = setTimeoutFn(onTimer, Math.max(0, minIntervalMs - elapsed))
  }

  function teardown(): void {
    cancelTimer()
    pending = null
    if (clientStarted) {
      // close() writes a clear frame if connected, so no stale card is left.
      client.close()
      clientStarted = false
    }
    lastSentActivity = null
    lastSentAt = 0
  }

  function applySignal(signal: PresenceSignal): void {
    const settings = deps.settings()

    // Disabled is the operator's opt-out (D31): take presence down and let the
    // socket go, rather than hold a connection open for a feature that is off.
    if (!settings.enabled) {
      teardown()
      return
    }

    const activity = buildActivity(settings, signal, now())
    // Connect on the first thing worth showing — never merely to clear a client
    // that never started.
    if (activity !== null && !clientStarted) {
      client.start()
      clientStarted = true
    }
    push(activity)
  }

  return {
    update(signal: PresenceSignal): void {
      lastSignal = signal
      applySignal(signal)
    },

    onSettingsChanged(changes: readonly SettingsChange[]): void {
      if (!changes.some((change) => change.key.startsWith(DISCORD_KEY_PREFIX))) return
      if (lastSignal === null) {
        // No track context to re-derive from; still honour a live disable so a
        // card already up comes down at once.
        if (!deps.settings().enabled) teardown()
        return
      }
      applySignal(lastSignal)
    },

    stop(): void {
      teardown()
    }
  }
}
