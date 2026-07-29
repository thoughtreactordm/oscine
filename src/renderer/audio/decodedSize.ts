/**
 * Decoded-size arithmetic for **R1**.
 *
 * `decodeAudioData` yields float32 PCM resampled to the `AudioContext`'s rate,
 * so a decoded track costs `duration × targetSampleRate × channels × 4` bytes
 * regardless of how small the encoded file was. The source file's sample rate
 * is not part of that calculation.
 *
 * `estimateDecodedBytes` prices the settled buffer, and
 * `estimateDecodePeakBytes` turns that into the transient admission cost the R1
 * guard adds to `DecodedBufferLedger.issuedNotFreedBytes`. Both stay free of Web
 * Audio types so they remain testable under Node and usable before any decoding
 * has happened.
 */

const BYTES_PER_FLOAT32_SAMPLE = 4

/**
 * Cross-platform M1 exit probes measured decode-time renderer growth at
 * 1.90–1.95 decoded buffers above baseline. Round that up rather than treating
 * either sampled peak as an exact ceiling.
 */
const DECODE_PEAK_DECODED_MULTIPLIER = 2

/**
 * Predicted decoded size for use *before* decoding.
 *
 * This is one input to the M2 guard's peak estimate. `targetSampleRateHz` must
 * be the runtime `AudioContext.sampleRate`, not the source file's sample rate
 * from library metadata: `decodeAudioData` resamples to the context before
 * allocating the returned buffer. The caller supplies the number so this
 * module remains free of Web Audio types.
 *
 * Returns 0 when any input is missing, which is a sentinel — an unknown cost is
 * not a zero cost, and the guard routes it to streaming explicitly.
 */
export function estimateDecodedBytes(
  durationSec: number | null,
  targetSampleRateHz: number | null,
  channels: number | null
): number {
  if (!durationSec || !targetSampleRateHz || !channels) return 0
  if (durationSec < 0 || targetSampleRateHz < 0 || channels < 0) return 0
  return Math.round(durationSec * targetSampleRateHz * channels * BYTES_PER_FLOAT32_SAMPLE)
}

/**
 * Peak process growth to reserve before admitting a whole-buffer decode.
 *
 * The 2× term covers the decoded output plus the measured resampler/intermediate
 * transient. The encoded `ArrayBuffer` is held alongside them, so its size is a
 * separate additive term rather than hidden inside the multiplier.
 *
 * A zero decoded estimate means the track could not be priced. Preserve that
 * sentinel instead of returning only the encoded size and making an unknown
 * decode look cheap.
 */
export function estimateDecodePeakBytes(
  estimatedDecodedBytes: number,
  encodedBytes: number
): number {
  if (estimatedDecodedBytes <= 0 || encodedBytes < 0) return 0
  return Math.round(estimatedDecodedBytes * DECODE_PEAK_DECODED_MULTIPLIER + encodedBytes)
}

/**
 * Actual decoded size, from the frame count and channel count of a buffer that
 * already exists. Takes plain numbers rather than an `AudioBuffer` so this
 * module stays testable without a DOM.
 */
export function decodedBytes(frameCount: number, channels: number): number {
  if (frameCount <= 0 || channels <= 0) return 0
  return frameCount * channels * BYTES_PER_FLOAT32_SAMPLE
}

/** Human-readable size for log lines. Base 1024, one decimal place. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)}${units[unit]}`
}
