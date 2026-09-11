import { backoffDelayMs } from '../scrobble/backoff'
import { DISCORD_OP, encodeFrame, FrameDecoder, type DecodedFrame } from './frames'
import type { DiscordConnector, DiscordSocket } from './transport'

/**
 * The Discord IPC client and its connection lifecycle — **W20-2**.
 *
 * The socket half of presence, behind an interface so the service (W20-3) is
 * written against the contract and `tests/main/` runs against a fake socket with
 * no live Discord ever needed. It owns everything R12 makes first-class:
 * Discord-absent is quiet and expected (never throws, never blocks playback),
 * the socket dropping mid-session is reconnected with bounded backoff rather than
 * a spin, a rate-limit rejection is tolerated without desyncing the client's
 * current-state view, and presence is cleared on stop and on quit. See
 * `[[oscine-discord-presence]]` D31.
 *
 * No signal→activity mapping and no throttle policy live here — those are the
 * service's (W20-3). This is the mechanism; the activity is handed in already
 * built.
 */

/**
 * A Discord activity, in Discord's own wire shape (snake_case, deliberately — it
 * is an external protocol object, not an Oscine type). W20-3 builds it; the
 * client only forwards it. `null` clears presence.
 */
export interface DiscordActivity {
  /** Activity type; `2` is "Listening to". */
  type?: number
  details?: string
  state?: string
  timestamps?: {
    start?: number
    end?: number
  }
  assets?: {
    large_image?: string
    large_text?: string
    small_image?: string
    small_text?: string
  }
}

/**
 * The client's connection state, first-class per R12.
 *
 * `unavailable` (Discord not running) is a resting state with a retry pending,
 * not a failure — the distinction the settings surface (W20-4) will draw between
 * "off" and "on but Discord isn't here".
 */
export type DiscordConnectionState = 'idle' | 'connecting' | 'connected' | 'unavailable'

export interface DiscordClient {
  /**
   * Begin connecting, and keep the connection alive across Discord restarts.
   * Idempotent, and never throws — a missing Discord is a quiet retry.
   */
  start(): void
  /** The activity to broadcast, sent now if connected and on the next connect otherwise. `null` clears. */
  setActivity(activity: DiscordActivity | null): void
  /** The current connection state. */
  getState(): DiscordConnectionState
  /**
   * Clear presence and tear down for good — the stop/quit path. Idempotent, and
   * best-effort: it writes a clear frame if connected so no stale "Playing" card
   * is left behind, then closes. `start()` may be called again afterwards.
   */
  close(): void
}

export interface DiscordClientDeps {
  /** The public Application ID — presence's identity. See `appId.ts`. */
  readonly clientId: string
  /** Opens the first responding socket, or `null` when Discord is absent. */
  readonly connect: DiscordConnector
  /** The ordered socket paths to probe, resolved fresh per attempt. */
  readonly candidates: () => readonly string[]
  /** This process's pid, sent with `SET_ACTIVITY`. Defaults to `process.pid`. */
  readonly pid?: number
  /** `Math.random` in production; a fixed source in tests. */
  readonly random?: () => number
  readonly setTimeout?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  /** Notified on every state change, for a future availability readout (W20-4). */
  readonly onStateChange?: (state: DiscordConnectionState) => void
}

/** Reconnect backoff — the same equal-jitter curve as scrobbling, faster and shorter. */
export const DISCORD_RECONNECT_BASE_MS = 2_000
export const DISCORD_RECONNECT_MAX_MS = 60_000

/**
 * How long to wait for the handshake's `READY` before giving up on a socket that
 * accepted the connection but never answered — Discord dying mid-handshake. A
 * timeout, not a hang: without it the client would sit in `connecting` forever.
 */
export const DISCORD_HANDSHAKE_TIMEOUT_MS = 5_000

export function createDiscordClient(deps: DiscordClientDeps): DiscordClient {
  const pid = deps.pid ?? process.pid
  const random = deps.random ?? Math.random
  const setTimeoutFn = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle))

  let active = false
  let state: DiscordConnectionState = 'idle'
  let socket: DiscordSocket | null = null
  let desiredActivity: DiscordActivity | null = null
  let attempts = 0
  let nonce = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null

  function setState(next: DiscordConnectionState): void {
    if (state === next) return
    state = next
    deps.onStateChange?.(next)
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return
    clearTimeoutFn(reconnectTimer)
    reconnectTimer = null
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimer === null) return
    clearTimeoutFn(handshakeTimer)
    handshakeTimer = null
  }

  function scheduleReconnect(): void {
    if (!active) return
    clearReconnectTimer()
    const delay = backoffDelayMs({
      attempts,
      random,
      baseMs: DISCORD_RECONNECT_BASE_MS,
      maxMs: DISCORD_RECONNECT_MAX_MS
    })
    attempts += 1
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null
      void attempt()
    }, delay)
  }

  async function attempt(): Promise<void> {
    if (!active) return
    setState('connecting')
    const opened = await deps.connect(deps.candidates())
    // `close()` (or another attempt) may have won the race while we awaited.
    if (!active || socket !== null) {
      opened?.destroy()
      return
    }
    if (!opened) {
      setState('unavailable')
      scheduleReconnect()
      return
    }

    socket = opened
    const decoder = new FrameDecoder()
    const isCurrent = (): boolean => socket === opened

    opened.onData((chunk) => {
      if (!isCurrent()) return
      for (const frame of decoder.push(chunk)) onFrame(frame, opened)
    })
    opened.onClose(() => onDisconnect(opened))
    opened.onError(() => onDisconnect(opened))

    opened.write(encodeFrame(DISCORD_OP.HANDSHAKE, { v: 1, client_id: deps.clientId }))
    handshakeTimer = setTimeoutFn(() => {
      if (isCurrent()) onDisconnect(opened)
    }, DISCORD_HANDSHAKE_TIMEOUT_MS)
  }

  function onFrame(frame: DecodedFrame, from: DiscordSocket): void {
    if (!active || socket !== from) return
    if (frame.op === DISCORD_OP.CLOSE) {
      onDisconnect(from)
      return
    }
    if (frame.op === DISCORD_OP.PING) {
      from.write(encodeFrame(DISCORD_OP.PONG, frame.payload))
      return
    }
    if (frame.op !== DISCORD_OP.FRAME) return
    const payload = frame.payload as { evt?: string } | undefined
    if (payload?.evt === 'READY') {
      onReady()
    }
    // Every other frame — a SET_ACTIVITY acknowledgement or an ERROR (a
    // rate-limit rejection among them) — is intentionally ignored. Acting on a
    // rejection would desync `desiredActivity` from what the operator is actually
    // playing; the service re-throttles and the next transition re-sends.
  }

  function onReady(): void {
    clearHandshakeTimer()
    attempts = 0
    setState('connected')
    flush()
  }

  function onDisconnect(from: DiscordSocket): void {
    if (socket !== from) return
    clearHandshakeTimer()
    socket = null
    from.destroy()
    if (!active) {
      setState('idle')
      return
    }
    setState('connecting')
    scheduleReconnect()
  }

  function flush(): void {
    if (!socket || state !== 'connected') return
    // Omitting `activity` is Discord's clear; a present one sets it.
    const args: { pid: number; activity?: DiscordActivity } = { pid }
    if (desiredActivity) args.activity = desiredActivity
    socket.write(
      encodeFrame(DISCORD_OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce: String((nonce += 1)) })
    )
  }

  return {
    start(): void {
      if (active) return
      active = true
      void attempt()
    },

    setActivity(activity: DiscordActivity | null): void {
      desiredActivity = activity
      if (state === 'connected') flush()
    },

    getState(): DiscordConnectionState {
      return state
    },

    close(): void {
      if (!active) return
      active = false
      clearReconnectTimer()
      clearHandshakeTimer()
      const open = socket
      socket = null
      if (open) {
        if (state === 'connected') {
          // Clear on quit/stop, so a closed Oscine leaves no stale card.
          desiredActivity = null
          open.write(
            encodeFrame(DISCORD_OP.FRAME, {
              cmd: 'SET_ACTIVITY',
              args: { pid },
              nonce: String((nonce += 1))
            })
          )
        }
        open.destroy()
      }
      setState('idle')
    }
  }
}
