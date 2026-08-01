import { FermataError } from '@shared/errors'
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type AudioErrorCode,
  type AudioTransitionPolicy,
  type NormalizationPolicy,
  type PlaybackStatus,
  type SampleAccurateTime
} from './AudioEngine'
import type { AudioPath, DecodedAudioPath, TrackAudioSource } from './AudioPath'
import { Emitter } from './emitter'
import {
  DEFAULT_NORMALIZATION_POLICY,
  resolveNormalization,
  type NormalizationDecision
} from './normalization'
import {
  decideR1Admission,
  R1ReservationLedger,
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
  normalizationDiagnostic?: (decision: TrackNormalizationDiagnostic) => void
  normalizationPolicy?: NormalizationPolicy
  reservations?: R1ReservationLedger
}

export interface TrackNormalizationDiagnostic extends NormalizationDecision {
  trackId: number
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
  #policy: R1Policy
  readonly #diagnostic: (decision: R1AdmissionDecision) => void
  readonly #normalizationDiagnostic: (decision: TrackNormalizationDiagnostic) => void
  readonly #reservations: R1ReservationLedger
  readonly #unsubscribes: Array<() => void> = []

  #streaming: AudioPath | null = null
  #active: AudioPath | null = null
  #trackId: number | null = null
  #status: PlaybackStatus = 'idle'
  #transitionPolicy: AudioTransitionPolicy = 'hard'
  #volume = 1
  #normalizationPolicy: NormalizationPolicy
  #audioSource: TrackAudioSource | null = null
  #generation = 0
  #disposed = false

  constructor(deps: GuardedAudioEngineDeps) {
    this.#decoded = deps.decoded
    this.#createStreaming = deps.createStreaming
    this.#resolveTrack = deps.resolveTrack
    this.#policy = resolveR1Policy(deps.policy)
    this.#reservations = deps.reservations ?? new R1ReservationLedger()
    this.#normalizationPolicy = deps.normalizationPolicy ?? DEFAULT_NORMALIZATION_POLICY
    this.#diagnostic =
      deps.diagnostic ??
      ((decision) => {
        console.info('[audio] R1 admission', JSON.stringify(decision))
      })
    this.#normalizationDiagnostic =
      deps.normalizationDiagnostic ??
      ((decision) => {
        console.info('[audio] ReplayGain', JSON.stringify(decision))
      })
    this.#decoded.setNormalizationPolicy(this.#normalizationPolicy)
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

  get normalizationPolicy(): NormalizationPolicy {
    return this.#normalizationPolicy
  }

  get decodePolicy(): Readonly<R1Policy> {
    return this.#policy
  }

  /**
   * Change R1's budgets under a playing track.
   *
   * Lands at the next admission rather than the current one — a track already
   * decoded and audible is not re-priced, because the only way to act on a
   * verdict that has changed would be to stop it. That is the same "at the next
   * boundary" contract the crossfade has, and it is why these are settings
   * rather than launch flags.
   *
   * Runs through `resolveR1Policy`, so this is not a way around the guard's own
   * ceiling however the value got here.
   */
  setDecodePolicy(policy: Partial<R1Policy>): void {
    this.#policy = resolveR1Policy(policy)
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

  get sampleAccurateEndTime(): SampleAccurateTime | null {
    if (this.#transitionPolicy !== 'sample-accurate') return null
    return this.#active?.sampleAccurateEndTime ?? null
  }

  scheduleSampleAccurateStart(at: SampleAccurateTime, fadeInDurationSec = 0): boolean {
    if (this.#transitionPolicy !== 'sample-accurate') return false
    return this.#active?.scheduleSampleAccurateStart(at, fadeInDurationSec) ?? false
  }

  scheduleSampleAccurateFadeOut(at: SampleAccurateTime, durationSec: number): boolean {
    if (this.#transitionPolicy !== 'sample-accurate') return false
    return this.#active?.scheduleSampleAccurateFadeOut(at, durationSec) ?? false
  }

  adoptScheduledStart(): boolean {
    if (this.#transitionPolicy !== 'sample-accurate') return false
    return this.#active?.adoptScheduledStart() ?? false
  }

  cancelScheduledStart(): void {
    this.#active?.cancelScheduledStart()
  }

  cancelScheduledFade(): void {
    this.#active?.cancelScheduledFade()
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
    this.#audioSource = null
    this.#decoded.unload()
    this.#streaming?.unload()
    this.#trackId = trackId
    this.#setStatus('loading')

    try {
      const source = await this.#resolveTrack(trackId)
      this.#assertCurrent(generation, trackId)
      this.#audioSource = source
      this.#emitNormalizationDiagnostic(source)

      const decision = decideR1Admission(
        {
          trackId,
          durationSec: source.durationSec,
          channels: source.channels,
          encodedBytes: source.encodedBytes,
          targetSampleRateHz: this.#decoded.targetSampleRateHz,
          issuedNotFreedBytes: this.#decoded.issuedNotFreedBytes,
          reservedDecodeBytes: this.#reservations.reservedBytes
        },
        this.#policy
      )
      this.#diagnostic(decision)
      this.#transitionPolicy = decision.transitionPolicy

      const path = decision.path === 'decoded' ? this.#decoded : this.#streamingPath()
      this.#active = path
      const releaseReservation =
        decision.path === 'decoded' && decision.transientReservationBytes !== null
          ? this.#reservations.reserve(decision.transientReservationBytes)
          : null
      try {
        await path.load(source)
      } finally {
        releaseReservation?.()
      }
      this.#assertCurrent(generation, trackId)
    } catch (err) {
      if (generation !== this.#generation) {
        throw new AudioEngineError('aborted', 'Load superseded by a newer track.', trackId)
      }

      const pathOwnedFailure = this.#active !== null
      const failure = this.#toFailure(err, trackId)
      this.#active = null
      this.#audioSource = null
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

  setNormalizationPolicy(policy: NormalizationPolicy): void {
    this.#normalizationPolicy = policy
    this.#decoded.setNormalizationPolicy(policy)
    this.#streaming?.setNormalizationPolicy(policy)
    if (this.#audioSource) this.#emitNormalizationDiagnostic(this.#audioSource)
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
    this.#audioSource = null
    this.#status = 'idle'
    this.#transitionPolicy = 'hard'
  }

  #streamingPath(): AudioPath {
    if (this.#streaming) return this.#streaming
    const streaming = this.#createStreaming()
    streaming.setVolume(this.#volume)
    streaming.setNormalizationPolicy(this.#normalizationPolicy)
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

  #emitNormalizationDiagnostic(source: TrackAudioSource): void {
    this.#normalizationDiagnostic({
      trackId: source.trackId,
      ...resolveNormalization(source, this.#normalizationPolicy)
    })
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
