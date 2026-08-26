import type { NowPlayingIdleInterval } from '@shared/settings'

/**
 * The auto-show arming rule — G4.
 *
 * Kept a pure function of a plain record for the reason `paletteShortcut` is:
 * `useIdleAutoShow` reads the setting, the transport and the route off their
 * stores and hands the answer here, so the rule can be tested without a
 * `window`, a timer or Pinia. Three conditions arm the idle countdown and all
 * three are here — a chosen interval, audio actually sounding, and a frame that
 * is not already Now Playing, because there is nothing to reveal when the deck
 * is the view.
 */
export interface IdleAutoShowGate {
  readonly interval: NowPlayingIdleInterval
  readonly playing: boolean
  readonly onNowPlaying: boolean
}

/**
 * The idle interval in milliseconds while the auto-show is armed, or 0 when it
 * must stand down. `off`, a stopped transport, and a frame already on Now
 * Playing all disarm; every live interval is a whole number of minutes carried
 * as its own string, so `Number` is exact.
 */
export function armedIntervalMs(gate: IdleAutoShowGate): number {
  if (gate.interval === 'off') return 0
  if (!gate.playing) return 0
  if (gate.onNowPlaying) return 0
  return Number(gate.interval) * 60_000
}

/**
 * One step of the trailing idle timer, from how long it has been since the last
 * interaction.
 *
 * A single timeout carries the countdown rather than a reset on every event:
 * `pointermove` alone would restart a timer hundreds of times through one drag.
 * The interaction handler only stamps the last-activity time; when the timeout
 * lands it asks here whether enough quiet has passed to reveal Now Playing, or
 * how much of the interval is left to wait out before asking again.
 */
export function idleStep(
  idleMs: number,
  intervalMs: number
): { readonly reveal: boolean; readonly nextDelayMs: number } {
  if (idleMs >= intervalMs) return { reveal: true, nextDelayMs: 0 }
  return { reveal: false, nextDelayMs: intervalMs - idleMs }
}
