import type { Track } from '@shared/library'
import type { RecordListenRequest } from '@shared/listens'
import {
  beginListen,
  learnDuration,
  listenProgress,
  observePosition,
  type ListenState
} from './listenAccumulator'

/**
 * One listen at a time, and the departure that commits it — **D17**, W10-4.
 *
 * The accumulator is a pure fold over positions and knows nothing about when a
 * listen ends; this is the piece that does. It holds at most one in-flight
 * listen, feeds it what the transport observes, and commits it at *departure* —
 * track end, skip, stop, or the transport moving on.
 *
 * Free of Vue and of IPC for the same reason the accumulator is free of Web
 * Audio: the claims worth testing here are about *when* a row is written and
 * how many, and a test that has to stand up a store and a bridge to ask that
 * question is a test nobody writes. The sink is injected.
 *
 * ## Departure is idempotent
 *
 * `depart` commits and clears, so calling it twice writes once. That is load
 * bearing rather than defensive: the scheduler emits `ended` and then
 * `playstart` at a natural boundary, `stop` may follow either, and `dispose`
 * follows everything. Making the *order* of those signals irrelevant is much
 * cheaper than making every caller agree about it — and cheaper than the bug
 * where a signal added later quietly double-counts.
 */

export interface ListenRecorderDeps {
  /**
   * Where a committed listen goes. Fire-and-forget by construction, exactly
   * like `onPlayStarted`: writing a row must not be able to delay, fail or
   * reorder the audio that caused it.
   */
  commit: (listen: RecordListenRequest) => void
  /** The transport-commit clock. Injected so a test never races a real one. */
  now?: () => number
  /** Forwarded to the accumulator. See `SEEK_EPSILON_MS`. */
  seekEpsilonMs?: number
}

export interface ListenRecorder {
  /**
   * A track has begun playing. Departs whatever was in flight first.
   *
   * Per *pass*, not per track: repeat-one comes back through the boundary and
   * emits `playstart` again, which is a second listen with a second
   * `startedAt`, not one listen of double length.
   */
  begin(track: Track): void
  /** Fold in one observation of the engine's playhead. */
  observe(positionMs: number, playing: boolean): void
  /** Fill in a duration the library did not have. Never revises a known one. */
  learn(durationMs: number | null): void
  /** Departure. Commits if the threshold was crossed; clears either way. */
  depart(): void
  /** Test seam: the listen in flight, or `null`. */
  inFlight(): ListenState | null
}

export function createListenRecorder(deps: ListenRecorderDeps): ListenRecorder {
  const now = deps.now ?? Date.now

  let state: ListenState | null = null
  let trackId: number | null = null

  function depart(): void {
    const departing = state
    const id = trackId
    // Cleared before the sink runs, not after. `commit` is a call into the
    // outside world, and a re-entrant departure finding the same state still
    // sitting here is how one listen becomes two rows.
    state = null
    trackId = null
    if (!departing || id === null) return

    const progress = listenProgress(departing)
    if (!progress.crossedThreshold) return
    deps.commit({
      trackId: id,
      startedAt: progress.startedAt,
      msListened: progress.msListened
    })
  }

  return {
    begin(track: Track): void {
      depart()
      // Podcast episodes play through the same transport but carry the negative
      // synthetic id `episodePlaybackTrackId` mints, and `listens.track_id`
      // references `tracks`. Main would resolve the snapshot to nothing and
      // write no row, so there is nothing for an accumulator to accumulate
      // towards. Revisit if episode listening ever wants a log of its own.
      if (track.id <= 0) return
      trackId = track.id
      state = beginListen({
        startedAt: now(),
        durationMs: track.durationSec === null ? null : track.durationSec * 1000,
        ...(deps.seekEpsilonMs === undefined ? {} : { seekEpsilonMs: deps.seekEpsilonMs })
      })
    },

    observe(positionMs: number, playing: boolean): void {
      if (state) state = observePosition(state, positionMs, playing)
    },

    learn(durationMs: number | null): void {
      if (state) state = learnDuration(state, durationMs)
    },

    depart,

    inFlight: (): ListenState | null => state
  }
}
