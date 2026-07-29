export const GAPLESS_SAMPLE_RATE = 8_000
export const GAPLESS_LEFT_SAMPLES = 257
export const GAPLESS_RIGHT_SAMPLES = 263

/**
 * A continuous, non-periodic signal whose adjacent samples differ at the join.
 * Odd split lengths also keep the boundary away from a 128-frame render
 * quantum, so quantum rounding cannot accidentally make the fixture pass.
 */
export function continuousGaplessSignal(): Float32Array {
  return Float32Array.from(
    { length: GAPLESS_LEFT_SAMPLES + GAPLESS_RIGHT_SAMPLES },
    (_, sample) =>
      Math.sin((2 * Math.PI * sample) / 37) * 0.61 + Math.sin((2 * Math.PI * sample) / 83) * 0.23
  )
}
