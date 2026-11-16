import { describe, expect, it } from 'vitest'
import {
  R128_Q78_MAX,
  R128_Q78_MIN,
  gainDbToR128Q78,
  parseR128Q78,
  r128Q78ToGainDb
} from '@shared/audio/r128'

describe('r128Q78ToGainDb', () => {
  it('reads Q7.8 against −23 LUFS as ReplayGain 2.0 dB', () => {
    expect(r128Q78ToGainDb(0)).toBe(5)
    expect(r128Q78ToGainDb(-256)).toBe(4)
    expect(r128Q78ToGainDb(-2560)).toBe(-5)
    expect(r128Q78ToGainDb(128)).toBe(5.5)
  })

  it('covers the full 16-bit range', () => {
    expect(r128Q78ToGainDb(R128_Q78_MIN)).toBe(-123)
    expect(r128Q78ToGainDb(R128_Q78_MAX)).toBeCloseTo(132.996, 3)
  })
})

describe('gainDbToR128Q78', () => {
  it('is the inverse, rounding to the nearest 1/256 dB', () => {
    expect(gainDbToR128Q78(5)).toBe(0)
    expect(gainDbToR128Q78(-5)).toBe(-2560)
    expect(gainDbToR128Q78(-7.42)).toBe(Math.round(-12.42 * 256))
  })

  it('never yields negative zero', () => {
    expect(Object.is(gainDbToR128Q78(5 - 1 / 1024), 0)).toBe(true)
  })

  it('clamps a gain the format cannot express instead of wrapping', () => {
    expect(gainDbToR128Q78(1000)).toBe(R128_Q78_MAX)
    expect(gainDbToR128Q78(-1000)).toBe(R128_Q78_MIN)
    expect(gainDbToR128Q78(-123)).toBe(R128_Q78_MIN)
    expect(gainDbToR128Q78(-123.5)).toBe(R128_Q78_MIN)
  })

  it('refuses a non-finite gain', () => {
    expect(() => gainDbToR128Q78(Number.NaN)).toThrow(RangeError)
    expect(() => gainDbToR128Q78(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('round-trips every Q7.8 integer exactly', () => {
    for (let q = R128_Q78_MIN; q <= R128_Q78_MAX; q += 1) {
      if (gainDbToR128Q78(r128Q78ToGainDb(q)) !== q) throw new Error(`q=${q} did not round-trip`)
    }
  })

  it('round-trips decibels to within half a step', () => {
    for (const db of [-30.1, -12.345, -0.004, 0, 3.21, 18.75]) {
      expect(Math.abs(r128Q78ToGainDb(gainDbToR128Q78(db)) - db)).toBeLessThanOrEqual(1 / 512)
    }
  })
})

describe('parseR128Q78', () => {
  it('reads a signed decimal integer', () => {
    expect(parseR128Q78('-1234')).toBe(-1234)
    expect(parseR128Q78('+77')).toBe(77)
    expect(parseR128Q78(' 512 ')).toBe(512)
    expect(Object.is(parseR128Q78('-0'), 0)).toBe(true)
  })

  it('accepts the range bounds and rejects past them', () => {
    expect(parseR128Q78('-32768')).toBe(R128_Q78_MIN)
    expect(parseR128Q78('32767')).toBe(R128_Q78_MAX)
    expect(parseR128Q78('-32769')).toBeNull()
    expect(parseR128Q78('32768')).toBeNull()
  })

  it('treats anything other than an integer as malformed', () => {
    for (const text of ['', ' ', '-12.5', '-3 dB', '0x10', 'abc', '1e3', '--5']) {
      expect(parseR128Q78(text)).toBeNull()
    }
  })
})
