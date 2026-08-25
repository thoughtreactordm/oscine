/**
 * How much of the playing track was *actually audible*, and whether that has
 * crossed the listened threshold — **D17**.
 *
 * Deliberately free of Web Audio, of Vue and of timers, for the same reason
 * `playbackClock.ts` is: the rule this file encodes is the one thing in the
 * listening path that has to be right, and a rule that can only be exercised by
 * playing audio for four minutes is a rule that never gets exercised. It is a
 * pure state value and a handful of functions over it, fed position and
 * play/pause state by the playback controller, which is where the position
 * already is.
 *
 * The commit that turns a crossed threshold into a `listens` row happens at
 * *departure* and lives in main (W10-4). Nothing here writes anything.
 *
 * ## Milliseconds, throughout
 *
 * The engine and the controller count in seconds because that is what an
 * `AudioContext` clock reads in. Everything downstream of here — `ms_listened`,
 * `started_at`, `duration_ms` — is milliseconds. The conversion happens once, at
 * the controller's call into `observePosition`, rather than being carried
 * through this file as a unit that means two things depending on which field
 * you are looking at.
 */

/**
 * The floor below which a track cannot be listened to at all.
 *
 * Strictly greater: a track of exactly this length never crosses, however many
 * times it is replayed.
 */
export const MIN_LISTENABLE_DURATION_MS = 30_000

/**
 * The cap on the half-duration rule. Four minutes.
 *
 * This is what stops an hour-long mix from needing half an hour before it
 * counts, and it is also the whole threshold for a track whose duration is not
 * known — see `thresholdMs`.
 */
export const LISTEN_TIME_CAP_MS = 240_000

/**
 * The largest forward position jump that is treated as playback rather than as
 * a seek.
 *
 * Position deltas are the only signal this file has, and it wants them for a
 * reason: observing seek *events* means trusting that every path which can move
 * the playhead remembers to announce it, including the ones added later. A
 * delta larger than the tick cadence can only be a jump, whoever caused it.
 *
 * Two seconds is eight ticks at `DecodedAudioEngine`'s 250 ms cadence — enough
 * headroom for a stalled main thread or a decode hitch to eat several ticks and
 * still have the gap read as the playback it was. The failure modes are not
 * symmetric, which is why the headroom is generous: too small and real
 * listening is silently discarded whenever the machine is busy; too large and a
 * seek shorter than the epsilon over-credits by at most the epsilon, and a seek
 * that short is not how anyone scrubs through a track.
 */
export const SEEK_EPSILON_MS = 2_000

/**
 * One track's listen, in progress.
 *
 * Immutable: `observePosition` returns a new value rather than mutating, so a
 * table-driven test is a fold and a caller cannot accidentally share one
 * accumulator between two tracks.
 */
export interface ListenState {
  /**
   * When the listen started, UTC ms, stamped at the transport-commit moment.
   *
   * Not when the threshold was crossed and not when the track ended: it is the
   * timestamp both Last.fm and ListenBrainz define, and it is also the true
   * answer to "when did you listen to this".
   */
  readonly startedAt: number
  /** The track's length, or `null` while unknown. See `learnDuration`. */
  readonly durationMs: number | null
  /** Accumulated audible time. May exceed `durationMs` — a replayed region counts twice. */
  readonly msListened: number
  /**
   * The last position credited against, or `null` when there is no baseline to
   * measure from — freshly begun, paused, or just seeked.
   *
   * A null baseline costs at most one tick of credit on resume, which is the
   * honest direction to be wrong in.
   */
  readonly lastPositionMs: number | null
  readonly seekEpsilonMs: number
}

/** What the rest of the system asks this file for. */
export interface ListenProgress {
  readonly startedAt: number
  /** Accumulated audible time, rounded — `listens.ms_listened` is an INTEGER. */
  readonly msListened: number
  readonly crossedThreshold: boolean
}

export interface BeginListenParams {
  /** UTC ms at transport-commit. The caller stamps it; this file never reads a clock. */
  readonly startedAt: number
  /** The track's length in ms where known. `null` is legal and common before the first decode. */
  readonly durationMs?: number | null
  readonly seekEpsilonMs?: number
}

/**
 * A fresh accumulator for one pass over one track.
 *
 * *Per pass*, not per track: repeat-one plays the same track twice and that is
 * two listens with two `startedAt` values, not one listen of double length.
 */
export function beginListen(params: BeginListenParams): ListenState {
  return {
    startedAt: params.startedAt,
    durationMs: usableDuration(params.durationMs ?? null),
    msListened: 0,
    lastPositionMs: null,
    seekEpsilonMs:
      params.seekEpsilonMs !== undefined && Number.isFinite(params.seekEpsilonMs)
        ? Math.max(0, params.seekEpsilonMs)
        : SEEK_EPSILON_MS
  }
}

/**
 * Fill in a duration that was not known when the listen began.
 *
 * The library's `durationSec` can be `null` for a track that has never been
 * decoded, and the engine only reports a real duration once it has one. Without
 * this, such a track would be judged by the four-minute rule when a
 * three-minute one should have crossed at ninety seconds.
 *
 * A duration already known is **never revised**. A threshold that moves under a
 * listen in progress is a worse failure than a duration off by the few
 * milliseconds a decoder and a tag disagree about.
 */
export function learnDuration(state: ListenState, durationMs: number | null): ListenState {
  if (state.durationMs !== null) return state
  const usable = usableDuration(durationMs)
  if (usable === null) return state
  return { ...state, durationMs: usable }
}

/**
 * Fold one observation of the playhead into the listen.
 *
 * `positionMs` is where the *engine* says playback has reached — not where a
 * scrub handle has been dragged to. Feeding the handle would credit a drag
 * across the track as listening, which is precisely the thing Last.fm's rule
 * about scrubbing exists to prevent.
 */
export function observePosition(
  state: ListenState,
  positionMs: number,
  playing: boolean
): ListenState {
  // Paused time does not count, and the baseline goes with it: the playhead can
  // be moved while paused, and measuring the resumed position against a
  // pre-seek baseline would credit the gap.
  if (!playing) return state.lastPositionMs === null ? state : { ...state, lastPositionMs: null }

  // A non-finite position is a caller bug. Dropping the baseline rather than
  // the state means the listen resumes accumulating on the next good tick
  // instead of being poisoned by an arithmetic that never recovers.
  if (!Number.isFinite(positionMs)) {
    return state.lastPositionMs === null ? state : { ...state, lastPositionMs: null }
  }

  const position = Math.max(0, positionMs)
  const previous = state.lastPositionMs
  if (previous === null) return { ...state, lastPositionMs: position }

  const delta = position - previous
  // Backward is a seek by definition; forward beyond the epsilon is one by
  // measurement. Either way the region jumped over was not audible, so it earns
  // nothing — but the new position becomes the baseline, so replaying a region
  // after seeking back into it counts it a second time.
  if (delta < 0 || delta > state.seekEpsilonMs) return { ...state, lastPositionMs: position }

  return { ...state, msListened: state.msListened + delta, lastPositionMs: position }
}

/**
 * The accumulated time at which this track becomes a listen, or `null` when it
 * can never become one.
 *
 * Last.fm's rule, adopted wholesale rather than re-derived: longer than thirty
 * seconds, **and** half its duration or four minutes, whichever comes first.
 * Twenty years of tuning against real listening is not worth relitigating, and
 * matching it verbatim is what keeps Oscine's numbers and the operator's
 * Last.fm profile from disagreeing and then needing explaining.
 *
 * An unknown duration falls back to the four-minute cap alone. That is not a
 * relaxation of the thirty-second floor but a proof of it: a track that has
 * accumulated four minutes of audible time is longer than thirty seconds,
 * whatever the library failed to record about it.
 */
export function thresholdMs(durationMs: number | null): number | null {
  if (durationMs === null) return LISTEN_TIME_CAP_MS
  if (durationMs <= MIN_LISTENABLE_DURATION_MS) return null
  return Math.min(durationMs / 2, LISTEN_TIME_CAP_MS)
}

export function crossedThreshold(state: ListenState): boolean {
  const threshold = thresholdMs(state.durationMs)
  if (threshold === null) return false
  return state.msListened >= threshold
}

/** The three facts W10-4 commits, and the only ones anything outside asks for. */
export function listenProgress(state: ListenState): ListenProgress {
  return {
    startedAt: state.startedAt,
    msListened: Math.round(state.msListened),
    crossedThreshold: crossedThreshold(state)
  }
}

/**
 * A duration this file can reason about, or `null`.
 *
 * Zero, negative and non-finite all mean "not known" rather than "instant":
 * a zero-length track would otherwise cross its threshold before it started.
 */
function usableDuration(durationMs: number | null): number | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null
  return durationMs
}
