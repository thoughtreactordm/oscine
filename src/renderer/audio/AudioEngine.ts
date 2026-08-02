/**
 * The playback contract the rest of the renderer sees.
 *
 * This file is the deliverable. D2 chose a pipeline that decodes whole tracks
 * into memory and accepted a known ceiling (**R1**) on one condition: that the
 * choice stays invisible above this line. M2's admission guard and media-element
 * fallback both implement the controls here, and no UI file changes when a
 * track switches paths.
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

/**
 * How the scheduler may join this track to its neighbour.
 *
 * Streaming fallback is deliberately `hard`: media elements are not
 * sample-accurate and must never be presented to the scheduler as eligible for
 * gapless or crossfade timing.
 */
export type AudioTransitionPolicy = 'sample-accurate' | 'hard'

/** Loudness-normalization policy applied independently of volume and fades. */
export type { NormalizationMode, NormalizationPolicy } from './normalization'

/**
 * A point on the private clock shared by decoded engine slots.
 *
 * The token is intentionally opaque. It lets an engine reject a point from a
 * different AudioContext without exposing that browser object above the audio
 * implementation seam.
 */
export interface SampleAccurateTime {
  readonly timeline: symbol
  readonly timeSec: number
}

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

/**
 * Length of the buffer `readWaveform` fills.
 *
 * A power of two because every implementation of this interface is going to be
 * backed by something with an FFT-shaped window, and a caller that had to ask
 * how big its buffer should be would be asking about the implementation. 1024
 * samples is ~21ms at 48kHz: long enough that a bass period fits inside one
 * frame, short enough that the shape still tracks a transient.
 */
export const WAVEFORM_SAMPLE_COUNT = 1024

/**
 * The buffer `readWaveform` fills.
 *
 * Pinned to a plain `ArrayBuffer` rather than the default `ArrayBufferLike`. A
 * view over shared memory is not something an audio backend can be handed, and
 * a caller that tried would find out by exception at frame rate. Still a
 * language type, so the no-Web-Audio rule above holds.
 */
export type WaveformBuffer = Float32Array<ArrayBuffer>

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
  /**
   * Switch loudness policy. An audible source ramps to the new gain.
   *
   * Takes the whole policy rather than the mode alone (W8-9): the pre-amp and
   * the untagged-track fallback change the gain of a playing source exactly as
   * the mode does, and a second setter for them would be a second ramp racing
   * the first.
   */
  setNormalizationPolicy(policy: NormalizationPolicy): void

  /**
   * Change R1's memory budgets. Applies from the next `load`.
   *
   * On the interface rather than hidden inside the guard because R1's ceiling is
   * a property of *an* engine, not of this one implementation: whatever replaces
   * the decode path still has to be told how much memory it may hold, and a
   * caller that could not tell it would have to reach past this interface to a
   * concrete class. The implementation is free to clamp — and does.
   */
  setDecodePolicy(policy: Partial<R1Policy>): void

  readonly currentTime: number
  /** Length in seconds, or 0 when nothing is loaded. */
  readonly duration: number
  readonly volume: number
  readonly normalizationPolicy: NormalizationPolicy
  /** The budgets in force, already clamped to what the guard will honour. */
  readonly decodePolicy: Readonly<R1Policy>
  readonly status: PlaybackStatus
  /** The loaded track, or `null`. */
  readonly trackId: number | null
  /** R2 boundary policy for the loaded track. */
  readonly transitionPolicy: AudioTransitionPolicy
  /**
   * How R1 priced the loaded track, or `null` before the first admission.
   *
   * This is the one place the guard's verdict is legible from above the line,
   * and it is here rather than in a diagnostic callback because a fallback to
   * `<audio>` is not a debugging detail — it is the reason a boundary was hard
   * and a seek was slow, and W7-3 makes it the one thing an operator can look
   * up. `transitionPolicy` is the same verdict reduced to the single bit the
   * scheduler acts on; this is the whole of it, for the surface that explains
   * it. Nothing above may *act* on it: a UI that changed behaviour on `path`
   * would be a UI that knows which engine won, which is exactly what the note
   * at the top of this file forbids.
   *
   * A plain getter rather than an event because it changes only at `load`, and
   * `statuschange` already fires there — a second event would be a second thing
   * to keep in step with the first.
   */
  readonly admission: R1AdmissionDecision | null
  /**
   * Exact end of the currently running decoded source. `null` means this
   * engine is stopped, streaming, or otherwise ineligible for a gapless join.
   */
  readonly sampleAccurateEndTime: SampleAccurateTime | null

  /**
   * Start a prepared decoded source at an exact shared-timeline point.
   *
   * A successful call starts Web Audio scheduling but deliberately leaves
   * public ownership unchanged. The scheduler calls `adoptScheduledStart` when
   * the preceding source ends; it must not call `play()` and rebuild the node.
   */
  scheduleSampleAccurateStart(at: SampleAccurateTime, fadeInDurationSec?: number): boolean
  /**
   * Apply an equal-power fade to the source which is already playing.
   *
   * This is a numeric shared-timeline contract on purpose: the scheduler can
   * coordinate two decoded slots without learning about AudioParam or any
   * other Web Audio primitive.
   */
  scheduleSampleAccurateFadeOut(at: SampleAccurateTime, durationSec: number): boolean
  /** Publish a previously scheduled source as playing without rebuilding it. */
  adoptScheduledStart(): boolean
  /** Stop a scheduled-but-not-yet-adopted source. Safe when none exists. */
  cancelScheduledStart(): void
  /** Remove outgoing transition automation and restore unity without a step. */
  cancelScheduledFade(): void

  /**
   * Copy the most recent time-domain samples of whatever is sounding into
   * `into`, and report whether anything was written.
   *
   * `into` must hold `WAVEFORM_SAMPLE_COUNT` floats; the samples land in −1..1.
   * False means nothing is audible right now — the buffer is left untouched, so
   * a caller animating from it decays its own state rather than snapping to a
   * flat line. Callers must not assume a cadence: this is a poll, and reading it
   * twice inside one render quantum returns the same window twice.
   *
   * It is on the interface for the same reason `setDecodePolicy` is. The tap is
   * a property of *an* engine, not of the Web Audio one — whatever replaces the
   * decode path still has samples passing through it, and a UI that had to reach
   * past this line to see them would be naming an `AnalyserNode`, which is
   * exactly what the file header forbids. A `Float32Array` is a language type,
   * not a Web Audio one, and it is caller-owned so the poll allocates nothing.
   *
   * Implementations tap **after loudness normalization and any transition fade,
   * but before the master volume**. Normalization and crossfades are things the
   * track is doing and belong in the picture; the volume slider is something the
   * operator is doing to the room, and a waveform that collapsed when they
   * turned it down would read as a fault.
   */
  readWaveform(into: WaveformBuffer): boolean

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void

  /** Release the audio device and every listener. The engine is unusable after. */
  dispose(): void
}
import type { NormalizationPolicy } from './normalization'
import type { R1AdmissionDecision, R1Policy } from './r1Admission'
