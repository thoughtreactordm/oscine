const EQUAL_POWER_CURVE_POINTS = 257

/** Complementary amplitude curve whose paired squared gains sum to unity. */
export function equalPowerCurve(direction: 'in' | 'out'): Float32Array {
  return Float32Array.from({ length: EQUAL_POWER_CURVE_POINTS }, (_, index) => {
    const phase = (index / (EQUAL_POWER_CURVE_POINTS - 1)) * (Math.PI / 2)
    return direction === 'in' ? Math.sin(phase) : Math.cos(phase)
  })
}
