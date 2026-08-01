import type { ReplayGainSource, TrackReplayGain } from '@shared/library'
import {
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB
} from '@shared/settings'

export const NORMALIZATION_MODES = ['off', 'track', 'album'] as const
export type NormalizationMode = (typeof NORMALIZATION_MODES)[number]

/**
 * Everything the loudness decision needs, as one value.
 *
 * It is a value rather than three arguments because it travels: the controller
 * resolves it from settings, hands it to the scheduler, which hands it to each
 * engine slot, which hands it to each path. Three parameters would be three
 * chances for one of them to be dropped at a hop, and the symptom would be a
 * pre-amp that works until the track changes.
 */
export interface NormalizationPolicy {
  mode: NormalizationMode
  /** Added to a track's own measurement. Peak limiting still applies after it. */
  preampDb: number
  /**
   * Applied instead, to a track with no measurement at all.
   *
   * Not added to the pre-amp: these two knobs move the tagged and the untagged
   * parts of a library relative to each other, and folding one into the other
   * would make it impossible to close the gap between them.
   */
  fallbackGainDb: number
}

/**
 * The policy an engine runs with before anybody sets one.
 *
 * Derived from the registry, which is the whole of W8-9's rule: this module used
 * to declare `DEFAULT_NORMALIZATION_MODE = 'track'` beside a descriptor that
 * said `album`, and playback used this one. Now there is one place to be wrong.
 */
export const DEFAULT_NORMALIZATION_POLICY: Readonly<NormalizationPolicy> = Object.freeze({
  mode: AUDIO_REPLAY_GAIN_MODE.default,
  preampDb: AUDIO_REPLAY_GAIN_PREAMP_DB.default,
  fallbackGainDb: AUDIO_REPLAY_GAIN_FALLBACK_DB.default
})

/**
 * The default policy with one field replaced.
 *
 * For the callers that genuinely only have a mode — a test asserting what album
 * mode does, a control that switches mode and nothing else. Built from the
 * registry-derived default rather than from literals, so it stays one place to
 * be wrong rather than becoming the second.
 */
export function normalizationPolicyForMode(mode: NormalizationMode): NormalizationPolicy {
  return { ...DEFAULT_NORMALIZATION_POLICY, mode }
}

export function sameNormalizationPolicy(a: NormalizationPolicy, b: NormalizationPolicy): boolean {
  return a.mode === b.mode && a.preampDb === b.preampDb && a.fallbackGainDb === b.fallbackGainDb
}

export type ReplayGainField = 'track' | 'album' | null

export interface NormalizationDecision {
  mode: NormalizationMode
  field: ReplayGainField
  source: ReplayGainSource | null
  /** The track's own measurement, before the pre-amp. `null` when untagged. */
  gainDb: number | null
  peak: number | null
  /** What was actually asked for, in dB: measurement plus pre-amp, or fallback. */
  requestedGainDb: number
  /** Safe linear amplitude to write to an AudioParam. */
  effectiveGain: number
  peakLimited: boolean
}

function finite(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Converts a decibel gain to linear amplitude.
 *
 * Extreme finite inputs can still overflow `Math.pow`; unity is the safe
 * fallback because no non-finite value may reach Web Audio.
 */
export function dbToLinear(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 1
  const linear = Math.pow(10, gainDb / 20)
  return Number.isFinite(linear) && linear >= 0 ? linear : 1
}

/**
 * Resolve the explicit M2 policy into one safe gain value.
 *
 * Album mode falls back as a pair: an album gain selects the album peak, even
 * when that peak is absent. Mixing a track peak into an album gain would claim
 * clipping protection from measurements that do not correspond.
 *
 * W8-9 added the two dB offsets. The pre-amp is peak-limited exactly as a
 * measurement is — that is the point of asking for headroom rather than taking
 * it — whereas the untagged fallback has no peak to be limited against and is
 * applied as asked. The descriptor's help text says so; there is nothing this
 * function could measure that would make it safer.
 */
export function resolveNormalization(
  replayGain: TrackReplayGain,
  policy: NormalizationPolicy
): NormalizationDecision {
  const { mode } = policy
  if (mode === 'off') {
    return {
      mode,
      field: null,
      source: replayGain.rgSource,
      gainDb: null,
      peak: null,
      requestedGainDb: 0,
      effectiveGain: 1,
      peakLimited: false
    }
  }

  const albumGain = finite(replayGain.rgAlbumGainDb)
  const useAlbum = mode === 'album' && albumGain !== null
  const field: ReplayGainField = useAlbum ? 'album' : 'track'
  const gainDb = useAlbum ? albumGain : finite(replayGain.rgTrackGainDb)
  const peak = finite(useAlbum ? replayGain.rgAlbumPeak : replayGain.rgTrackPeak)

  if (gainDb === null) {
    const fallbackDb = finite(policy.fallbackGainDb) ?? 0
    const fallbackGain = dbToLinear(fallbackDb)
    return {
      mode,
      field,
      source: replayGain.rgSource,
      gainDb: null,
      peak,
      requestedGainDb: fallbackDb,
      effectiveGain: fallbackGain,
      peakLimited: false
    }
  }

  const requestedGainDb = gainDb + (finite(policy.preampDb) ?? 0)
  const requestedGain = dbToLinear(requestedGainDb)
  const clippingCeiling = peak !== null && peak > 0 ? 1 / peak : Number.POSITIVE_INFINITY
  const effectiveGain = Math.min(requestedGain, clippingCeiling)
  const safeGain = Number.isFinite(effectiveGain) && effectiveGain >= 0 ? effectiveGain : 1

  return {
    mode,
    field,
    source: replayGain.rgSource,
    gainDb,
    peak,
    requestedGainDb,
    effectiveGain: safeGain,
    peakLimited: safeGain < requestedGain
  }
}
