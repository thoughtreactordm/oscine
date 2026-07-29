import { FermataError } from '@shared/errors'
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type AudioErrorCode,
  type AudioTransitionPolicy,
  type PlaybackStatus
} from './AudioEngine'
import type { AudioPath, DecodedAudioPath, TrackAudioSource } from './AudioPath'
import { Emitter } from './emitter'
import {
  decideR1Admission,
  resolveR1Policy,
  type R1AdmissionDecision,
  type R1Policy
} from './r1Admission'

export interface GuardedAudioEngineDeps {
  decoded: DecodedAudioPath
  createStreaming: () => AudioPath
  resolveTrack: (trackId: number) => Promise<TrackAudioSource>
  policy?: Partial<R1Policy>
  diagnostic?: (decision: R1AdmissionDecision) => void
}

/**
 * The public, two-path engine.
 *
 * It owns routing and public state while the path engines own browser audio
 * primitives. A path is selected only after the metadata-only resolver has
 * completed and R1 has priced the request.
 */
export class GuardedAudioEngine implements AudioEngine {
  readonly #events = new Emitter<AudioEngineEventMap>()
  readonly #decoded: DecodedAudioPath
  readonly #createStreaming: () => AudioPath
  readonly #resolveTrack: (trackId: number) => Promise<TrackAudioSource>
  readonly #policy: R1Policy
  readonly #diagnostic: (decision: R1AdmissionDecision) => void
  readonly #unsubscribes: Array<() => void> = []

  #streaming: AudioPath | null = null
  #active: AudioPath | null = null
  #trackId: number | null = null
  #status: PlaybackStatus = 'idle'
  #transitionPolicy: AudioTransitionPolicy = 'hard'
  #volume = 1
  #generation = 0
  #disposed = false

  constructor(deps: GuardedAudioEngineDeps) {
    this.#decoded = deps.decoded
    this.#createStreaming = deps.createStreaming
    this.#resolveTrack = deps.resolveTrack
    this.#policy = resolveR1Policy(deps.policy)
    this.#diagnostic =
      deps.diagnostic ??
      ((decision) => {
        console.info('[audio] R1 admission', JSON.stringify(decision))
      })
    this.#watch(this.#decoded)
  }

  get currentTime(): number {
    return this.#active?.currentTime ?? 0
  }

  get duration(): number {
    return this.#active?.duration ?? 0
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

  get transitionPolicy(): AudioTransitionPolicy {
    return this.#transitionPolicy
  }

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void {
    return this.#events.on(type, listener)
  }

  async load(trackId: number): Promise<void> {
    this.#assertUsable()
    const generation = ++this.#generation

    // Stop both paths before metadata IPC. The previous track goes silent when
    // replacement is requested, not after a database or protocol round trip.
    this.#active = null
    this.#decoded.unload()
    this.#streaming?.unload()
    this.#trackId = trackId
    this.#setStatus('loading')

    try {
      const source = await this.#resolveTrack(trackId)
      this.#assertCurrent(generation, trackId)

      const decision = decideR1Admission(
        {
          trackId,
          durationSec: source.durationSec,
          channels: source.channels,
          encodedBytes: source.encodedBytes,
          targetSampleRateHz: this.#decoded.targetSampleRateHz,
          issuedNotFreedBytes: this.#decoded.issuedNotFreedBytes
        },
        this.#policy
      )
      this.#diagnostic(decision)
      this.#transitionPolicy = decision.transitionPolicy

      const path = decision.path === 'decoded' ? this.#decoded : this.#streamingPath()
      this.#active = path
      await path.load(source)
      this.#assertCurrent(generation, trackId)
    } catch (err) {
      if (generation !== this.#generation) {
        throw new AudioEngineError('aborted', 'Load superseded by a newer track.', trackId)
      }

      const pathOwnedFailure = this.#active !== null
      const failure = this.#toFailure(err, trackId)
      this.#active = null
      this.#trackId = null
      this.#transitionPolicy = 'hard'
      this.#setStatus('idle')
      // Path engines emit their own load failure before rejecting. Resolver
      // failures happen above the path seam, so the wrapper emits those.
      if (!pathOwnedFailure) this.#events.emit('error', failure)
      throw failure
    }
  }

  async play(): Promise<void> {
    this.#assertUsable()
    if (!this.#active) {
      throw new AudioEngineError('internal', 'Nothing is loaded.', this.#trackId)
    }
    await this.#active.play()
  }

  pause(): void {
    this.#active?.pause()
  }

  seek(seconds: number): void {
    this.#assertUsable()
    this.#active?.seek(seconds)
  }

  setVolume(gain: number): void {
    const target = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 0
    this.#volume = target
    this.#decoded.setVolume(target)
    this.#streaming?.setVolume(target)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#active = null
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#unsubscribes.length = 0
    this.#decoded.dispose()
    this.#streaming?.dispose()
    this.#events.clear()
    this.#trackId = null
    this.#status = 'idle'
    this.#transitionPolicy = 'hard'
  }

  #streamingPath(): AudioPath {
    if (this.#streaming) return this.#streaming
    const streaming = this.#createStreaming()
    streaming.setVolume(this.#volume)
    this.#streaming = streaming
    this.#watch(streaming)
    return streaming
  }

  #watch(path: AudioPath): void {
    this.#unsubscribes.push(
      path.on('statuschange', (status) => {
        if (this.#active === path) this.#setStatus(status)
      }),
      path.on('timeupdate', (position) => {
        if (this.#active === path) this.#events.emit('timeupdate', position)
      }),
      path.on('ended', (event) => {
        if (this.#active === path) this.#events.emit('ended', event)
      }),
      path.on('error', (error) => {
        if (this.#active === path) this.#events.emit('error', error)
      })
    )
  }

  #setStatus(status: PlaybackStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#events.emit('statuschange', status)
  }

  #assertCurrent(generation: number, trackId: number): void {
    if (generation !== this.#generation) {
      throw new AudioEngineError('aborted', 'Load superseded by a newer track.', trackId)
    }
  }

  #toFailure(err: unknown, trackId: number): AudioEngineError {
    if (err instanceof AudioEngineError) return err
    if (err instanceof FermataError) {
      const code: AudioErrorCode = err.code === 'not-found' ? 'not-found' : 'io-error'
      return new AudioEngineError(code, err.message, trackId)
    }
    return new AudioEngineError('internal', 'Playback failed unexpectedly.', trackId)
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AudioEngineError('internal', 'This audio engine has been disposed.')
    }
  }
}
