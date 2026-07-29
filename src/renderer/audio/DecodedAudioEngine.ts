import { AudioEngineError, type AudioEngineEventMap, type PlaybackStatus } from './AudioEngine'
import type { DecodedAudioPath, TrackAudioSource } from './AudioPath'
import { DecodedBufferLedger } from './decodedBufferLedger'
import { DecodedAudioContextPool, type DecodedAudioContextLease } from './decodedAudioContext'
import { decodedBytes, formatBytes } from './decodedSize'
import { Emitter } from './emitter'
import { clamp, pausedAt, positionAt, type PlaybackClock } from './playbackClock'

/**
 * D2's pipeline: fetch the whole track, `decodeAudioData` it, play the
 * resulting buffer through `AudioBufferSourceNode` → `GainNode` → destination.
 *
 * The R1 guard lives immediately above this path and is the only production
 * caller. By the time `load` is reached, metadata was priced at this context's
 * sample rate and the whole-buffer decode was admitted.
 */

/**
 * Gain ramp length. Assigning `gain.value` steps the parameter within one
 * render quantum, which is audible as a click; ~15ms is inaudible as a ramp and
 * still feels instant.
 */
const VOLUME_RAMP_SEC = 0.015

/**
 * Time-update cadence. Fast enough for a smooth progress bar, slow enough to
 * stay off the render path. Deliberately not `requestAnimationFrame`, which
 * stops when the window is hidden — a music player's clock must keep running
 * while it is in the background.
 */
const TIME_UPDATE_MS = 250

export class DecodedAudioEngine implements DecodedAudioPath {
  readonly #context: AudioContext
  readonly #contextLease: DecodedAudioContextLease<AudioContext>
  readonly #gain: GainNode
  readonly #events = new Emitter<AudioEngineEventMap>()
  readonly #decodedBuffers: DecodedBufferLedger

  #buffer: AudioBuffer | null = null
  #source: AudioBufferSourceNode | null = null
  #trackId: number | null = null
  #status: PlaybackStatus = 'idle'
  #clock: PlaybackClock = pausedAt(0)
  #volume = 1
  #ticker: ReturnType<typeof setInterval> | null = null
  /** Bumped by every `load`, so a decode that finishes late can tell it lost. */
  #generation = 0
  #releaseGestureHooks: (() => void) | null = null
  #fetchAbort: AbortController | null = null
  #disposed = false

  constructor(
    decodedBuffers: DecodedBufferLedger = new DecodedBufferLedger(),
    contextLease: DecodedAudioContextLease<AudioContext> = new DecodedAudioContextPool(
      () => new AudioContext()
    ).acquire()
  ) {
    this.#decodedBuffers = decodedBuffers
    this.#contextLease = contextLease
    this.#context = contextLease.context
    this.#gain = this.#context.createGain()
    this.#gain.gain.value = this.#volume
    this.#gain.connect(this.#context.destination)
    this.#armGestureResume()
  }

  get currentTime(): number {
    return positionAt(this.#clock, this.#context.currentTime, this.duration)
  }

  get duration(): number {
    return this.#buffer?.duration ?? 0
  }

  get volume(): number {
    return this.#volume
  }

  get status(): PlaybackStatus {
    return this.#status
  }

  get trackId(): number | null {
    return this.#trackId
  }

  get targetSampleRateHz(): number {
    return this.#context.sampleRate
  }

  get issuedNotFreedBytes(): number {
    return this.#decodedBuffers.issuedNotFreedBytes
  }

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void {
    return this.#events.on(type, listener)
  }

  async load(source: TrackAudioSource): Promise<void> {
    this.#assertUsable()

    const trackId = source.trackId
    const generation = ++this.#generation
    // Tear down before the await, not after: the old track must go silent the
    // moment a new one is asked for, not whenever the network gets around to it.
    this.#stopTicker()
    this.#teardownSource()
    this.#fetchAbort?.abort()
    const fetchAbort = new AbortController()
    this.#fetchAbort = fetchAbort
    this.#buffer = null
    this.#trackId = trackId
    this.#clock = pausedAt(0)
    this.#setStatus('loading')

    try {
      const response = await fetch(source.url, { signal: fetchAbort.signal })
      if (!response.ok) {
        throw new AudioEngineError(
          response.status === 404 ? 'not-found' : 'io-error',
          'That track could not be read.',
          trackId
        )
      }

      const encoded = await response.arrayBuffer()
      if (generation !== this.#generation) {
        throw new AudioEngineError('aborted', 'Load superseded by a newer track.', trackId)
      }
      // Read this *before* decoding: `decodeAudioData` detaches the buffer it
      // is given, after which `byteLength` reads 0 and the R1 log line would
      // quietly record every file as empty.
      const encodedByteLength = encoded.byteLength
      const buffer = await this.#context.decodeAudioData(encoded)
      this.#decodedBuffers.track(buffer, decodedBytes(buffer.length, buffer.numberOfChannels))

      // A slower earlier load must not overwrite a faster later one.
      if (generation !== this.#generation) {
        throw new AudioEngineError('aborted', 'Load superseded by a newer track.', trackId)
      }

      this.#buffer = buffer
      if (this.#fetchAbort === fetchAbort) this.#fetchAbort = null
      this.#logDecodeCost(trackId, encodedByteLength, buffer)
      this.#setStatus('ready')
      this.#emitTime()
    } catch (err) {
      const superseded = generation !== this.#generation
      if (superseded) {
        // The newer load owns the engine's state now. Reject this caller's
        // promise, but touch nothing and stay quiet — being replaced is not a
        // fault, and an error toast here would be a lie.
        throw err instanceof AudioEngineError && err.code === 'aborted'
          ? err
          : new AudioEngineError('aborted', 'Load superseded by a newer track.', trackId)
      }

      const failure = this.#toFailure(err, trackId)
      if (this.#fetchAbort === fetchAbort) this.#fetchAbort = null
      this.#trackId = null
      this.#setStatus('idle')
      this.#events.emit('error', failure)
      throw failure
    }
  }

  unload(): void {
    if (this.#disposed) return
    this.#generation += 1
    this.#fetchAbort?.abort()
    this.#fetchAbort = null
    this.#stopTicker()
    this.#teardownSource()
    this.#buffer = null
    this.#trackId = null
    this.#clock = pausedAt(0)
    this.#setStatus('idle')
  }

  async play(): Promise<void> {
    this.#assertUsable()
    if (!this.#buffer) {
      throw new AudioEngineError('internal', 'Nothing is loaded.', this.#trackId)
    }
    if (this.#status === 'playing') return

    // Chromium's autoplay policy suspends the context until a user gesture.
    // `play` is normally called from a click, which makes this the one moment
    // the resume is reliable; the constructor's listeners are the fallback for
    // playback started any other way.
    if (this.#context.state === 'suspended') await this.#context.resume()

    // Play after the end means play again, not resume at the end.
    if (this.#status === 'ended') this.#clock = pausedAt(0)

    this.#startSource(this.#clock.offsetSec)
    this.#setStatus('playing')
    this.#startTicker()
    this.#emitTime()
  }

  pause(): void {
    if (this.#status !== 'playing') return

    // Read the position before tearing the source down — teardown stops the run
    // this reading is derived from.
    const position = this.currentTime
    this.#teardownSource()
    this.#clock = pausedAt(position)
    this.#stopTicker()
    this.#setStatus('paused')
    this.#emitTime()
  }

  seek(seconds: number): void {
    this.#assertUsable()
    if (!this.#buffer) return

    const target = clamp(seconds, 0, this.duration)

    if (this.#status === 'playing') {
      // An AudioBufferSourceNode cannot be restarted or repositioned — it is
      // single-use. Seeking means building a new one at the new offset.
      this.#startSource(target)
    } else {
      this.#clock = pausedAt(target)
      // Seeking away from the end makes the track playable again.
      if (this.#status === 'ended') this.#setStatus('paused')
    }

    this.#emitTime()
  }

  setVolume(gain: number): void {
    // Clamped to unity. ReplayGain in M2 attaches to this same node, but as its
    // own factor — folding it into the user's volume here would make a slider
    // whose meaning changes per track.
    const target = clamp(gain, 0, 1)
    this.#volume = target

    if (this.#disposed) return

    const param = this.#gain.gain
    const now = this.#context.currentTime
    // Anchor at the current value first, or a ramp interrupted mid-flight jumps
    // to wherever the previous one was scheduled to be.
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(target, now + VOLUME_RAMP_SEC)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    this.#generation += 1
    this.#fetchAbort?.abort()
    this.#fetchAbort = null
    this.#stopTicker()
    this.#teardownSource()
    this.#buffer = null
    this.#releaseGestureHooks?.()
    this.#releaseGestureHooks = null
    this.#gain.disconnect()
    this.#events.clear()
    this.#contextLease.release()
  }

  // --- internals ---------------------------------------------------------

  /**
   * Build and start a fresh source node at `offsetSec`.
   *
   * Every play and every seek comes through here, because a source node cannot
   * be reused: once stopped it is spent, and `start` throws if called twice.
   */
  #startSource(offsetSec: number): void {
    const buffer = this.#buffer
    if (!buffer) return

    this.#teardownSource()

    const source = this.#context.createBufferSource()
    source.buffer = buffer
    source.connect(this.#gain)
    source.onended = () => {
      // Reaching here means the buffer ran out on its own: teardown clears this
      // handler before stopping, so a pause, seek or new load never arrives as
      // an end. The identity check covers the reverse — a node that ended after
      // being replaced must not speak for its successor.
      if (this.#source !== source) return
      this.#handleNaturalEnd()
    }

    source.start(0, offsetSec)
    this.#clock = { offsetSec, startedAtSec: this.#context.currentTime }
    this.#source = source
  }

  /**
   * Silence and release the current source.
   *
   * Clearing `onended` *before* stopping is what keeps the `ended` event
   * meaning "the track finished" — `stop()` fires `onended` too, so without
   * this every pause and every seek would announce a finished track and a queue
   * would advance on its own.
   */
  #teardownSource(): void {
    const source = this.#source
    if (!source) return

    source.onended = null
    try {
      source.stop()
    } catch {
      // Already stopped, or never started. Both are fine; there is no state
      // query for it, so the throw is the only way to find out.
    }
    source.disconnect()
    this.#source = null
  }

  #handleNaturalEnd(): void {
    const trackId = this.#trackId

    this.#stopTicker()
    this.#source?.disconnect()
    this.#source = null
    this.#clock = pausedAt(this.duration)
    this.#setStatus('ended')
    this.#emitTime()

    if (trackId !== null) this.#events.emit('ended', { trackId })
  }

  #setStatus(status: PlaybackStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#events.emit('statuschange', status)
  }

  #startTicker(): void {
    if (this.#ticker !== null) return
    this.#ticker = setInterval(() => this.#emitTime(), TIME_UPDATE_MS)
  }

  #stopTicker(): void {
    if (this.#ticker === null) return
    clearInterval(this.#ticker)
    this.#ticker = null
  }

  #emitTime(): void {
    this.#events.emit('timeupdate', { currentTime: this.currentTime, duration: this.duration })
  }

  /**
   * Resume the context on the first user gesture anywhere in the window.
   *
   * `play()` handles the common case. This covers playback that starts without
   * a gesture of its own — restoring a session, or a keyboard media key — where
   * the context would otherwise stay suspended and the app would look broken
   * while reporting that it is playing.
   */
  #armGestureResume(): void {
    if (this.#context.state !== 'suspended') return

    const types = ['pointerdown', 'keydown'] as const
    const resume = (): void => {
      void this.#context.resume()
      this.#releaseGestureHooks?.()
      this.#releaseGestureHooks = null
    }

    for (const type of types) {
      window.addEventListener(type, resume, { capture: true })
    }
    this.#releaseGestureHooks = () => {
      for (const type of types) {
        window.removeEventListener(type, resume, { capture: true })
      }
    }
  }

  /**
   * **R1 evidence.** The settled size checks the metadata estimator, while
   * `issuedNotFreed` exposes the conservative floor the guard adds to its next
   * decode admission cost. Comparing that figure with renderer RSS is how the
   * probe catches accounting that assumes a dropped reference was freed.
   */
  #logDecodeCost(trackId: number, encodedByteLength: number, buffer: AudioBuffer): void {
    const decoded = decodedBytes(buffer.length, buffer.numberOfChannels)
    const ratio = encodedByteLength > 0 ? (decoded / encodedByteLength).toFixed(1) : '?'

    console.info(
      `[audio] R1 track=${trackId} encoded=${formatBytes(encodedByteLength)} ` +
        `decoded=${formatBytes(decoded)} ratio=${ratio}x ` +
        `duration=${buffer.duration.toFixed(1)}s rate=${buffer.sampleRate}Hz ` +
        `channels=${buffer.numberOfChannels} ` +
        `issuedNotFreed=${formatBytes(this.#decodedBuffers.issuedNotFreedBytes)}`
    )
  }

  #toFailure(err: unknown, trackId: number): AudioEngineError {
    if (err instanceof AudioEngineError) return err

    // `decodeAudioData` rejects with an EncodingError DOMException whose message
    // is a Chromium internal string, so it gets replaced rather than shown.
    if (err instanceof DOMException) {
      return new AudioEngineError('decode-failed', 'This file could not be decoded.', trackId)
    }

    // `fetch` rejects with TypeError when the transfer itself fails.
    if (err instanceof TypeError) {
      return new AudioEngineError('io-error', 'That track could not be read.', trackId)
    }

    return new AudioEngineError('internal', 'Playback failed unexpectedly.', trackId)
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AudioEngineError('internal', 'This audio engine has been disposed.')
    }
  }
}
