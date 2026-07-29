/**
 * Exact endpoint of a decoded source on its AudioContext timeline.
 *
 * Kept as sample-rate-neutral seconds because that is the unit accepted by
 * `AudioBufferSourceNode.start()`. AudioBuffer durations are exact
 * `length / sampleRate` values on this same timeline.
 */
export function decodedSourceEndTimeSec(
  startTimeSec: number,
  durationSec: number,
  offsetSec: number
): number {
  return startTimeSec + (durationSec - offsetSec)
}
