/**
 * The listen commit — **D17**.
 *
 * One row per play that crossed the listened threshold, written once, at
 * *departure*. Not at threshold-crossing: a write when the rule is satisfied
 * plus an update when the track finally leaves is two writes and a window in
 * which the row is wrong, to record a number that is only final at the end
 * anyway. Departure is track end, skip, stop, or the transport moving on, and a
 * play that never crossed writes nothing at all.
 *
 * The renderer decides *whether* — it is the only process that knows what was
 * audible, by the standing invariant that audio lives there — and main decides
 * *what*, because everything on the row is a snapshot of library state resolved
 * through `track_overrides`, and the renderer never sees that table.
 *
 * `play_history` is untouched by any of this. It keeps being written at
 * transport-commit, unconditionally, skips included; see `history.ts` for why
 * two records answering different questions is the design.
 */

/**
 * What the renderer reports at departure. Three facts, and it knows all three.
 *
 * Note that `startedAt` comes from the renderer, where `history.record`'s
 * deliberately comes from main. The trail's rule does not transfer: it stamps
 * *now*, and there is no argument for letting a caller claim otherwise. A
 * listen's `started_at` is minutes old by the time it is committed — it is when
 * the transport first committed to the track, which is the timestamp both
 * Last.fm and ListenBrainz define — and main has no way to reconstruct it.
 */
export interface RecordListenRequest {
  readonly trackId: number
  /** UTC ms at the transport-commit moment, not at threshold or at departure. */
  readonly startedAt: number
  /** Accumulated audible ms. See `renderer/playback/listenAccumulator.ts`. */
  readonly msListened: number
}

/**
 * The row that was written, or `null` from the channel when none was.
 *
 * Deliberately not the whole snapshot. A caller that wants the title back can
 * read the log; what it cannot reconstruct is *whether the write happened*,
 * which has three ordinary causes for being no — see the store.
 */
export interface ListenCommit {
  readonly id: number
  readonly trackId: number
  readonly startedAt: number
  readonly msListened: number
}

/**
 * How long main waits for the renderer to answer a quit-time flush.
 *
 * A bound rather than a promise: the renderer being wedged must not be able to
 * stop the app from closing. Two seconds is far longer than one synchronous
 * SQLite insert and short enough that a user who has already asked to quit does
 * not conclude the app has hung.
 */
export const LISTEN_FLUSH_TIMEOUT_MS = 2_000
