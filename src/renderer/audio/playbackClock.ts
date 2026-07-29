/**
 * Playback position arithmetic, deliberately free of Web Audio so it can be
 * tested under plain Node — the unit suite has no DOM and no `AudioContext`.
 *
 * The engine never keeps a "current time" counter that it increments. An
 * `AudioBufferSourceNode` plays against the AudioContext's own clock, and any
 * counter maintained alongside that clock drifts away from what is audible.
 * Position is therefore always *derived*: where the current run began in the
 * track, plus how long the context clock says the run has lasted.
 */

export interface PlaybackClock {
  /** Offset into the track, in seconds, where the current run began. */
  offsetSec: number
  /**
   * The context clock reading when the current run began, or `null` when
   * nothing is running — paused, freshly loaded, or ended.
   */
  startedAtSec: number | null
}

/** A clock that is not running, parked at `offsetSec`. */
export function pausedAt(offsetSec: number): PlaybackClock {
  return { offsetSec, startedAtSec: null }
}

export function clamp(value: number, min: number, max: number): number {
  // NaN fails every comparison, so it would fall straight through Math.min/max
  // and poison the position. A non-finite seek target is a caller bug; the
  // engine's job is to stay in a valid state rather than propagate it.
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Where playback has reached, in seconds.
 *
 * Clamped to the track: a source that has run past its buffer keeps advancing
 * the context clock, and reporting a position beyond the end would show a
 * progress bar overshooting before the `ended` event lands.
 */
export function positionAt(
  clock: PlaybackClock,
  contextTimeSec: number,
  durationSec: number
): number {
  const elapsedSec =
    clock.startedAtSec === null ? 0 : Math.max(0, contextTimeSec - clock.startedAtSec)
  return clamp(clock.offsetSec + elapsedSec, 0, Math.max(0, durationSec))
}
