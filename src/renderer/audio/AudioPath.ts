import type { TrackAudioMetadata } from '@shared/library'
import type {
  AudioEngine,
  AudioEngineEventMap,
  NormalizationPolicy,
  PlaybackStatus,
  SampleAccurateTime
} from './AudioEngine'

/** Metadata and opaque media URL resolved before either playback path loads. */
export interface TrackAudioSource extends TrackAudioMetadata {
  trackId: number
  url: string
}

/**
 * Internal implementation seam below `AudioEngine`.
 *
 * The public engine still loads by opaque id. The guarded wrapper resolves that
 * id and hands this richer value to exactly one path after admission.
 */
export interface AudioPath {
  load(source: TrackAudioSource): Promise<void>
  unload(): void
  play(): Promise<void>
  pause(): void
  seek(seconds: number): void
  setVolume(gain: number): void
  setNormalizationPolicy(policy: NormalizationPolicy): void
  readonly currentTime: number
  readonly duration: number
  readonly volume: number
  readonly normalizationPolicy: NormalizationPolicy
  readonly status: PlaybackStatus
  readonly trackId: number | null
  readonly sampleAccurateEndTime: SampleAccurateTime | null
  scheduleSampleAccurateStart(at: SampleAccurateTime, fadeInDurationSec?: number): boolean
  scheduleSampleAccurateFadeOut(at: SampleAccurateTime, durationSec: number): boolean
  adoptScheduledStart(): boolean
  cancelScheduledStart(): void
  cancelScheduledFade(): void
  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void
  dispose(): void
}

/** The decoded path exposes only the figures the admission wrapper consumes. */
export interface DecodedAudioPath extends AudioPath {
  readonly targetSampleRateHz: number
  readonly issuedNotFreedBytes: number
}

/**
 * Compile-time guard that `AudioPath` continues to mirror the public controls.
 *
 * `decodePolicy` and its setter join `load` and `transitionPolicy` on the
 * exclusion list, and for the same reason those two are there: admission is the
 * guarded wrapper's job. A path is handed a track that has already been priced
 * and has no business knowing what the budget was.
 */
type MissingPublicMembers = Exclude<
  keyof AudioEngine,
  keyof AudioPath | 'load' | 'transitionPolicy' | 'decodePolicy' | 'setDecodePolicy'
>
const _allPublicMembersMirrored: MissingPublicMembers extends never ? true : never = true
void _allPublicMembersMirrored
