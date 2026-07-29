/**
 * The playback contract the rest of the renderer sees.
 *
 * This file is the deliverable. D2 chose a pipeline that decodes whole tracks
 * into memory and accepted a known ceiling (**R1**) on one condition: that the
 * choice stays invisible above this line. When R1 forces the WebCodecs rewrite,
 * a new class implements this interface, `createAudioEngine` returns it, and no
 * UI file changes.
 *
 * So: **no Web Audio type may appear below.** Not `AudioBuffer`, not
 * `AudioContext`, not `GainNode`, not `decodeAudioData`. Every quantity here is
 * a number, a string, or a domain type. If that stops being true, the
 * abstraction has already failed and the swap will not be clean — the leak, not
 * the inconvenience, is the thing to fix.
 *
 * Tracks are addressed by id for the same reason the IPC contract does it: the
 * renderer has no filesystem and never learns a path (see `Track` in
 * `@shared/library`).
 */

/**
 * What the engine is doing right now.
 *
 * `ready` and `paused` are distinct on purpose: both show a play button, but
 * only one of them means the user has heard any of this track. `ended` is not
 * `idle` — a finished track is still loaded, and `play()` restarts it without a
 * second decode.
 */
export type PlaybackStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended'

export const AUDIO_ERROR_CODES = [
  /** No such track, or main declined to serve its bytes. */
  'not-found',
  /** The bytes arrived but are not decodable — corrupt, or an unsupported codec. */
  'decode-failed',
  /** The transfer itself failed. */
  'io-error',
  /** A newer `load` superseded this one. Expected, and not a fault. */
  'aborted',
  /** Anything unanticipated. */
  'internal'
] as const

export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[number]

/**
 * A playback failure.
 *
 * Distinct from `FermataError` because the failure modes are distinct: nothing
 * on the IPC boundary can be `decode-failed`, and nothing here is `conflict`.
 * Sharing one enum would mean every handler switching over codes that cannot
 * occur in its half of the app.
 */
export class AudioEngineError extends Error {
  readonly code: AudioErrorCode
  /** The track the failure concerns, or `null` if none was loaded. */
  readonly trackId: number | null

  constructor(code: AudioErrorCode, message: string, trackId: number | null = null) {
    super(message)
    this.name = 'AudioEngineError'
    this.code = code
    this.trackId = trackId
  }
}

export interface PlaybackPosition {
  currentTime: number
  duration: number
}

export interface AudioEngineEventMap {
  /**
   * Fired on every status transition. A UI that polls `status` instead will
   * miss the transition through `loading` on a fast decode.
   */
  statuschange: PlaybackStatus
  /** Fired a few times a second while playing, and once after any seek. */
  timeupdate: PlaybackPosition
  /** The track played to its natural end. Not fired by `pause` or by teardown. */
  ended: { trackId: number }
  /**
   * A genuine playback fault.
   *
   * `load` both rejects *and* emits this, so a UI can subscribe once rather
   * than wrapping every call site — handle one or the other, not both. The one
   * exception is `aborted`: superseding a load is normal control flow, so it
   * rejects the stale promise without emitting here.
   */
  error: AudioEngineError
}

export interface AudioEngine {
  /**
   * Fetch and prepare a track, replacing whatever was loaded. Does not start
   * playback. Calling it again while one is in flight abandons the first, whose
   * promise rejects with `aborted`.
   */
  load(trackId: number): Promise<void>

  /**
   * Start or resume. Restarts from the beginning if the track has ended.
   *
   * Async because the audio device may need resuming first — browser autoplay
   * policy applies inside Electron, and the resume is only reliable when it
   * happens during a user gesture. Call this from a real event handler.
   */
  play(): Promise<void>

  pause(): void

  /** Jump to a position in seconds, clamped to the track. Keeps playing if playing. */
  seek(seconds: number): void

  /** Output level, 0 to 1. Applied smoothly enough to be click-free. */
  setVolume(gain: number): void

  readonly currentTime: number
  /** Length in seconds, or 0 when nothing is loaded. */
  readonly duration: number
  readonly volume: number
  readonly status: PlaybackStatus
  /** The loaded track, or `null`. */
  readonly trackId: number | null

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void

  /** Release the audio device and every listener. The engine is unusable after. */
  dispose(): void
}
