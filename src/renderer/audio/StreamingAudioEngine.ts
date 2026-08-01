import {
  AudioEngineError,
  type AudioEngineEventMap,
  type NormalizationPolicy,
  type PlaybackStatus,
  type SampleAccurateTime
} from './AudioEngine'
import type { AudioPath, TrackAudioSource } from './AudioPath'
import { Emitter } from './emitter'
import {
  DEFAULT_NORMALIZATION_POLICY,
  resolveNormalization,
  sameNormalizationPolicy
} from './normalization'
import { clamp } from './playbackClock'

export interface StreamingMedia {
  currentTime: number
  readonly duration: number
  readonly ended: boolean
  readonly readyState: number
  readonly errorCode: number | null
  setSource(url: string): void
  clearSource(): void
  load(): void
  play(): Promise<void>
  pause(): void
  on(type: 'loadedmetadata' | 'timeupdate' | 'ended' | 'error', listener: () => void): () => void
}

/**
 * Browser graph operations hidden behind a structural adapter. Keeping DOM
 * types out of this class lets its transport semantics run under plain Node.
 */
export interface StreamingPlatform {
  readonly media: StreamingMedia
  readonly contextState: string
  resumeContext(): Promise<void>
  setOutputVolume(gain: number): void
  setNormalizationGain(gain: number, ramp: boolean): void
  dispose(): void
}

const HAVE_METADATA = 1

export class StreamingAudioEngine implements AudioPath {
  readonly #platform: StreamingPlatform
  readonly #media: StreamingMedia
  readonly #events = new Emitter<AudioEngineEventMap>()
  readonly #unsubscribes: Array<() => void>

  #trackId: number | null = null
  #status: PlaybackStatus = 'idle'
  #volume = 1
  #normalizationPolicy: NormalizationPolicy = DEFAULT_NORMALIZATION_POLICY
  #audioSource: TrackAudioSource | null = null
  #metadataDuration = 0
  #generation = 0
  #cancelPending: (() => void) | null = null
  #disposed = false

  constructor(platform: StreamingPlatform) {
    this.#platform = platform
    this.#media = platform.media
    this.#unsubscribes = [
      this.#media.on('timeupdate', () => {
        if (this.#trackId !== null) this.#emitTime()
      }),
      this.#media.on('ended', () => this.#handleNaturalEnd())
    ]
  }

  get currentTime(): number {
    return Number.isFinite(this.#media.currentTime) ? this.#media.currentTime : 0
  }

  get duration(): number {
    return Number.isFinite(this.#media.duration) && this.#media.duration > 0
      ? this.#media.duration
      : this.#metadataDuration
  }

  get volume(): number {
    return this.#volume
  }

  get normalizationPolicy(): NormalizationPolicy {
    return this.#normalizationPolicy
  }

  get status(): PlaybackStatus {
    return this.#status
  }

  get trackId(): number | null {
    return this.#trackId
  }

  get sampleAccurateEndTime(): SampleAccurateTime | null {
    return null
  }

  scheduleSampleAccurateStart(_at: SampleAccurateTime, _fadeInDurationSec = 0): boolean {
    return false
  }

  scheduleSampleAccurateFadeOut(_at: SampleAccurateTime, _durationSec: number): boolean {
    return false
  }

  adoptScheduledStart(): boolean {
    return false
  }

  cancelScheduledStart(): void {}

  cancelScheduledFade(): void {}

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void {
    return this.#events.on(type, listener)
  }

  async load(source: TrackAudioSource): Promise<void> {
    this.#assertUsable()
    const generation = ++this.#generation
    this.#cancelPending?.()
    this.#cancelPending = null
    // Clear identity before touching the element: changing `src` can dispatch
    // terminal events for the old resource synchronously in some Chromium
    // versions, and those must not speak for either track.
    this.#trackId = null
    this.#audioSource = null
    this.#media.pause()
    this.#media.clearSource()
    this.#trackId = source.trackId
    this.#audioSource = source
    this.#metadataDuration = source.durationSec ?? 0
    this.#platform.setNormalizationGain(
      resolveNormalization(source, this.#normalizationPolicy).effectiveGain,
      false
    )
    this.#setStatus('loading')

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (action: () => void): void => {
          if (settled) return
          settled = true
          offMetadata()
          offError()
          if (this.#cancelPending === cancel) this.#cancelPending = null
          action()
        }
        const ready = (): void => finish(resolve)
        const failed = (): void => finish(() => reject(this.#mediaFailure(source.trackId)))
        const cancel = (): void =>
          finish(() =>
            reject(
              new AudioEngineError('aborted', 'Load superseded by a newer track.', source.trackId)
            )
          )
        const offMetadata = this.#media.on('loadedmetadata', ready)
        const offError = this.#media.on('error', failed)
        this.#cancelPending = cancel
        this.#media.setSource(source.url)
        this.#media.load()
        if (this.#media.readyState >= HAVE_METADATA) queueMicrotask(ready)
      })

      if (generation !== this.#generation) {
        throw new AudioEngineError('aborted', 'Load superseded by a newer track.', source.trackId)
      }
      this.#setStatus('ready')
      this.#emitTime()
    } catch (err) {
      if (generation !== this.#generation) {
        throw new AudioEngineError('aborted', 'Load superseded by a newer track.', source.trackId)
      }
      const failure =
        err instanceof AudioEngineError
          ? err
          : new AudioEngineError('internal', 'Playback failed unexpectedly.', source.trackId)
      this.#trackId = null
      this.#audioSource = null
      this.#metadataDuration = 0
      this.#setStatus('idle')
      if (failure.code !== 'aborted') this.#events.emit('error', failure)
      throw failure
    }
  }

  unload(): void {
    if (this.#disposed) return
    this.#generation += 1
    this.#cancelPending?.()
    this.#cancelPending = null
    this.#trackId = null
    this.#audioSource = null
    this.#media.pause()
    this.#media.clearSource()
    this.#metadataDuration = 0
    this.#setStatus('idle')
  }

  async play(): Promise<void> {
    this.#assertUsable()
    if (this.#trackId === null) {
      throw new AudioEngineError('internal', 'Nothing is loaded.')
    }
    if (this.#status === 'playing') return

    try {
      if (this.#platform.contextState === 'suspended') {
        await this.#platform.resumeContext()
      }
      if (this.#status === 'ended' || this.#media.ended) this.#media.currentTime = 0
      await this.#media.play()
      this.#setStatus('playing')
      this.#emitTime()
    } catch {
      const failure = new AudioEngineError(
        'internal',
        'Playback could not be started.',
        this.#trackId
      )
      this.#events.emit('error', failure)
      throw failure
    }
  }

  pause(): void {
    if (this.#status !== 'playing') return
    this.#media.pause()
    this.#setStatus('paused')
    this.#emitTime()
  }

  seek(seconds: number): void {
    this.#assertUsable()
    if (this.#trackId === null) return
    this.#media.currentTime = clamp(seconds, 0, this.duration)
    if (this.#status === 'ended') this.#setStatus('paused')
    this.#emitTime()
  }

  setVolume(gain: number): void {
    const target = clamp(gain, 0, 1)
    this.#volume = target
    if (!this.#disposed) this.#platform.setOutputVolume(target)
  }

  setNormalizationPolicy(policy: NormalizationPolicy): void {
    if (sameNormalizationPolicy(policy, this.#normalizationPolicy)) return
    this.#normalizationPolicy = policy
    if (!this.#disposed && this.#audioSource) {
      this.#platform.setNormalizationGain(
        resolveNormalization(this.#audioSource, policy).effectiveGain,
        true
      )
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.unload()
    this.#disposed = true
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#platform.dispose()
    this.#events.clear()
  }

  #handleNaturalEnd(): void {
    const trackId = this.#trackId
    if (trackId === null) return
    this.#setStatus('ended')
    this.#emitTime()
    this.#events.emit('ended', { trackId })
  }

  #mediaFailure(trackId: number): AudioEngineError {
    // HTMLMediaElement constants: aborted=1, network=2, decode=3, unsupported=4.
    const code = this.#media.errorCode
    if (code === 3 || code === 4) {
      return new AudioEngineError('decode-failed', 'This file could not be decoded.', trackId)
    }
    return new AudioEngineError('io-error', 'That track could not be read.', trackId)
  }

  #emitTime(): void {
    this.#events.emit('timeupdate', {
      currentTime: this.currentTime,
      duration: this.duration
    })
  }

  #setStatus(status: PlaybackStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#events.emit('statuschange', status)
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AudioEngineError('internal', 'This audio engine has been disposed.')
    }
  }
}
