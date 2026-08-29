/**
 * Perceptual volume taper.
 *
 * Loudness perception is roughly logarithmic: equal *ratios* of amplitude, not
 * equal amplitudes, read as equal steps. A slider whose position feeds straight
 * into `GainNode.gain` therefore spends most of its travel across levels that
 * already sound "full" and crams every useful quiet level into the last sliver
 * above zero — nudge it off maximum and almost nothing happens; the drop to
 * silence all lives in the bottom few percent. Passing the position through a
 * decibel taper first makes each equal slice of slider travel an equal change
 * in *perceived* loudness, which is what a volume control is supposed to feel
 * like.
 *
 * The slider position stays the user-facing volume: it is what gets persisted
 * and shown as a percentage, and keyboard nudges and the readout all work in
 * it. Only the value handed to Web Audio is tapered, so the number stays linear
 * while the sound does not.
 */

/**
 * Decibels below unity that the slider spans before its bottom snaps to
 * silence. Sixty is the usual reach of a hardware fader — enough range that the
 * quiet end is genuinely quiet without the taper going near-inaudible before
 * the halfway mark.
 */
export const VOLUME_TAPER_RANGE_DB = 60

/**
 * Map a slider position in `[0, 1]` to the linear amplitude for `GainNode.gain`.
 *
 * The endpoints are exact — `0` is true silence and `1` is unity — so a full
 * slider is bit-for-bit the untouched signal rather than a rounded power. Non-
 * finite input is treated as silence; nothing but a real number in range may
 * reach Web Audio.
 */
export function perceptualVolumeToAmplitude(position: number): number {
  if (!Number.isFinite(position) || position <= 0) return 0
  if (position >= 1) return 1
  return Math.pow(10, ((position - 1) * VOLUME_TAPER_RANGE_DB) / 20)
}

/**
 * The inverse: recover the slider position that produced a given amplitude.
 * Exact at the endpoints for the same reason, and the round-trip is stable
 * within floating-point error across the open interval.
 */
export function amplitudeToPerceptualVolume(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return 0
  if (amplitude >= 1) return 1
  return 1 + (20 * Math.log10(amplitude)) / VOLUME_TAPER_RANGE_DB
}
