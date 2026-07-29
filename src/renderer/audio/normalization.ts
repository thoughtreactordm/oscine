import type { ReplayGainSource, TrackReplayGain } from '@shared/library'

export const NORMALIZATION_MODES = ['off', 'track', 'album'] as const
export type NormalizationMode = (typeof NORMALIZATION_MODES)[number]

export const DEFAULT_NORMALIZATION_MODE: NormalizationMode = 'track'

export type ReplayGainField = 'track' | 'album' | null

export interface NormalizationDecision {
  mode: NormalizationMode
  field: ReplayGainField
  source: ReplayGainSource | null
  gainDb: number | null
  peak: number | null
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
 */
export function resolveNormalization(
  replayGain: TrackReplayGain,
  mode: NormalizationMode
): NormalizationDecision {
  if (mode === 'off') {
    return {
      mode,
      field: null,
      source: replayGain.rgSource,
      gainDb: null,
      peak: null,
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
    return {
      mode,
      field,
      source: replayGain.rgSource,
      gainDb: null,
      peak,
      effectiveGain: 1,
      peakLimited: false
    }
  }

  const requestedGain = dbToLinear(gainDb)
  const clippingCeiling = peak !== null && peak > 0 ? 1 / peak : Number.POSITIVE_INFINITY
  const effectiveGain = Math.min(requestedGain, clippingCeiling)
  const safeGain = Number.isFinite(effectiveGain) && effectiveGain >= 0 ? effectiveGain : 1

  return {
    mode,
    field,
    source: replayGain.rgSource,
    gainDb,
    peak,
    effectiveGain: safeGain,
    peakLimited: safeGain < requestedGain
  }
}
