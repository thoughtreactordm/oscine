import { watch, type Ref } from 'vue'
import type { PresenceSignal, PresenceTrack } from '@shared/presence'
import type { Track } from '@shared/library'
// The contract module, not the `audio/` barrel — same reason `mediaSession.ts`
// names it directly: nothing here may drag Web Audio into a node-config compile.
import type { PlaybackStatus } from '../audio/AudioEngine'

/**
 * Turns the controller's reactive playback state into the throttled
 * `presence.update` signal — **W20-1**, D31.
 *
 * ## Throttling is the whole point
 *
 * The engine ticks position every `TIME_UPDATE_MS` (250 ms). Forwarding that to
 * IPC is exactly the flood that starves the renderer (`[[abortsignal-any-electron]]`),
 * and Discord rate-limits presence to ~1/15s regardless. So this never emits on a
 * bare position tick. It emits on **state transitions** — play, pause, a track
 * change, and a *seek* (a position jump the free-running clock cannot explain) —
 * plus a low-frequency **heartbeat** so a long unpaused track keeps a live
 * progress bar. A steadily-advancing clock is not a transition and produces no
 * update between heartbeats.
 *
 * ## The seam it leaves
 *
 * It reads `enabled()` live before every emit, so a disabled feature emits
 * nothing at all. W20-4 defines `discord.enabled`; until then the store gates it
 * behind a constant. The heartbeat and the mapping to a Discord activity are
 * elsewhere by design — the activity is W20-3's, main-side; this stays plain
 * playback data.
 *
 * Framework-light on purpose: `now` and the interval timer are injected so the
 * transition and heartbeat logic is testable under plain Node with fake clocks.
 */

/** The heartbeat period — ~15s, matching Discord's presence rate-limit ceiling. */
export const PRESENCE_HEARTBEAT_MS = 15_000

/**
 * How far the reported position may diverge from a free-running clock before it
 * counts as a *seek* rather than the ordinary advance of playback.
 *
 * The engine ticks position roughly every 250 ms and wall-clock jitter between
 * ticks is well under a second; a whole second of unexplained movement — forward
 * or backward — is a deliberate jump presence must redraw the progress bar for.
 * A drag that lands within the tolerance of where the clock was heading is not a
 * jump, which is what keeps a scrub that merely nudges from spamming updates.
 */
export const PRESENCE_SEEK_TOLERANCE_MS = 1_000

export interface PresenceEmitterDeps {
  readonly status: Ref<PlaybackStatus>
  readonly nowPlaying: Ref<Track | null>
  /** Elapsed position, in **seconds** — the controller's unit. */
  readonly currentTime: Ref<number>
  /** Engine-reported track length, in **seconds**; a fallback for `durationMs`. */
  readonly duration: Ref<number>
  /** Whether presence is switched on at all. Read live before every emit. */
  readonly enabled: () => boolean
  /** The sink — the throttled `presence.update` channel. */
  readonly emit: (signal: PresenceSignal) => void
  /** Wall clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  readonly setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

export interface PresenceEmitter {
  /** Stops the watcher and the heartbeat. Safe to call twice. */
  dispose(): void
}

/**
 * `playing` is false only when nothing is loaded. A paused track is still
 * loaded, so it reports `playing: true, paused: true` — the state that lets
 * presence show "Paused" rather than vanish. A stop clears `nowPlaying`, which
 * is the "clear presence" signal.
 */
function isActive(status: PlaybackStatus, track: Track | null): boolean {
  return track !== null && status !== 'idle'
}

export function createPresenceEmitter(deps: PresenceEmitterDeps): PresenceEmitter {
  const now = deps.now ?? (() => Date.now())
  const setIntervalFn = deps.setInterval ?? ((handler, ms) => setInterval(handler, ms))
  const clearIntervalFn = deps.clearInterval ?? ((handle) => clearInterval(handle))

  function buildSignal(): PresenceSignal {
    const track = deps.nowPlaying.value
    const status = deps.status.value
    if (!isActive(status, track)) {
      return { track: null, positionMs: 0, paused: false, playing: false }
    }
    // `track` is non-null once `isActive` holds.
    const loaded = track as Track
    // Prefer the library's known length — available the instant the track
    // changes — over the engine's, which may not have reported the new track's
    // duration yet at the transition that emits. Fall back to the engine when the
    // library never knew it.
    const durationSec = loaded.durationSec ?? deps.duration.value
    const presenceTrack: PresenceTrack = {
      title: loaded.title,
      artist: loaded.artist,
      album: loaded.album,
      albumArtist: loaded.albumArtist,
      durationMs: Math.max(0, Math.round(durationSec * 1000))
    }
    return {
      track: presenceTrack,
      positionMs: Math.max(0, Math.round(deps.currentTime.value * 1000)),
      paused: status === 'paused',
      playing: true
    }
  }

  function tryEmit(): void {
    if (!deps.enabled()) return
    deps.emit(buildSignal())
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null

  function clearHeartbeat(): void {
    if (heartbeat === null) return
    clearIntervalFn(heartbeat)
    heartbeat = null
  }

  /**
   * A heartbeat runs only while a track is actively playing — not paused, not
   * stopped — so a long unpaused track keeps a live progress bar and nothing
   * else does. Restarted on every transition so the interval is measured from
   * the last emit, not from some fixed phase.
   */
  function restartHeartbeat(): void {
    clearHeartbeat()
    if (deps.status.value === 'playing' && deps.nowPlaying.value !== null) {
      heartbeat = setIntervalFn(() => tryEmit(), PRESENCE_HEARTBEAT_MS)
    }
  }

  // The seek detector's baseline: the last position sample and when, in wall
  // time, it was taken. Seeded from the current state so the first tick is
  // measured against a real baseline rather than zero.
  let lastStatus = deps.status.value
  let lastTrackId = deps.nowPlaying.value?.id ?? null
  let lastPositionMs = Math.max(0, Math.round(deps.currentTime.value * 1000))
  let lastSampleAt = now()

  // One watch over all three sources rather than three watches, so that a
  // transition which moves several at once (play resets position *and* status in
  // the same flush) collapses to a single evaluation and a single emit.
  const stop = watch([deps.status, deps.nowPlaying, deps.currentTime], () => {
    const at = now()
    const status = deps.status.value
    const trackId = deps.nowPlaying.value?.id ?? null
    const positionMs = Math.max(0, Math.round(deps.currentTime.value * 1000))

    const statusChanged = status !== lastStatus
    const trackChanged = trackId !== lastTrackId

    // A seek is only a seek when nothing else changed to explain the movement.
    // Expected advance is the wall time elapsed *if we were playing* across the
    // interval; a paused clock should not have advanced at all, so any movement
    // while paused is a seek.
    let seeked = false
    if (!statusChanged && !trackChanged) {
      const expected =
        lastStatus === 'playing' ? lastPositionMs + (at - lastSampleAt) : lastPositionMs
      seeked = Math.abs(positionMs - expected) > PRESENCE_SEEK_TOLERANCE_MS
    }

    lastStatus = status
    lastTrackId = trackId
    lastPositionMs = positionMs
    lastSampleAt = at

    if (statusChanged || trackChanged || seeked) {
      restartHeartbeat()
      tryEmit()
    }
  })

  return {
    dispose(): void {
      stop()
      clearHeartbeat()
    }
  }
}
