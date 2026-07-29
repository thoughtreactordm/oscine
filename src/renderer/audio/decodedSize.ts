/**
 * Decoded-size arithmetic for **R1**.
 *
 * `decodeAudioData` yields float32 PCM, so a decoded track costs
 * `duration × sampleRate × channels × 4` bytes regardless of how small the
 * encoded file was. A five-minute stereo 44.1kHz track is ~105MB; a twenty
 * minute mix is ~400MB.
 *
 * M1 ships no guard — that is D2's accepted cost and M2's job to fix. What M1
 * owes M2 is *evidence*: `estimateDecodedBytes` is the function M2's guard will
 * threshold on, and it lives here already so the guard is a caller change
 * rather than a rewrite. Kept free of Web Audio types so it stays testable
 * under Node and usable before any decoding has happened.
 */

const BYTES_PER_FLOAT32_SAMPLE = 4

/**
 * Predicted decoded size from metadata alone, for use *before* decoding.
 *
 * This is the M2 guard's input: the library database already stores duration,
 * sample rate and channel count, so a caller can price a track without paying
 * for it. Returns 0 when any input is missing, which is honest — an unknown
 * cost is not a zero cost, and M2 must decide explicitly what to do with a
 * track it cannot price rather than inherit a silent default from here.
 */
export function estimateDecodedBytes(
  durationSec: number | null,
  sampleRateHz: number | null,
  channels: number | null
): number {
  if (!durationSec || !sampleRateHz || !channels) return 0
  if (durationSec < 0 || sampleRateHz < 0 || channels < 0) return 0
  return Math.round(durationSec * sampleRateHz * channels * BYTES_PER_FLOAT32_SAMPLE)
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
