import type { PresenceSignal } from '@shared/presence'

/**
 * The main-side consumer of `presence.update` — **W20-1**.
 *
 * A one-method seam, so this foundation card can land the shared signal, the
 * channel and the renderer emitter without the Discord client (W20-2) or the
 * activity service (W20-3) existing yet. The presence service W20-3 builds
 * implements this interface and is swapped in at the wiring; until then
 * `createNoopPresenceSink` swallows the signal, which is what gives the emitter
 * a registered handler to talk to and keeps the registry completeness check
 * (`assertEveryChannelHandled`) satisfied.
 *
 * It lives in `src/main/discord/` because that is where the whole stream lands —
 * the mirror of `src/main/scrobble/`, per `[[oscine-discord-presence]]`.
 */
export interface PresenceSink {
  /**
   * Receive one presence signal. Fire-and-forget and never throws outward: a
   * `track: null` / `playing: false` signal is the ordinary "clear presence"
   * case, not an error, and R12 makes Discord-absent a quiet, expected state.
   */
  update(signal: PresenceSignal): void
}

/** The default sink: accepts every signal and does nothing with it. */
export function createNoopPresenceSink(): PresenceSink {
  return {
    update(): void {
      // W20-3 replaces this with the presence service. Until then presence is
      // dark end to end — the renderer emitter is gated off behind
      // `discord.enabled` (W20-4), so nothing reaches here anyway.
    }
  }
}
