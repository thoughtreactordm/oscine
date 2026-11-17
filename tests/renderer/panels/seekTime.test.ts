import { describe, expect, it } from 'vitest'
import { formatTime, pointerFraction } from '../../../src/renderer/panels/transport/seekTime'

describe('formatTime', () => {
  it('formats m:ss with a padded seconds field', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(248.9)).toBe('4:08')
    expect(formatTime(498)).toBe('8:18')
  })

  it('runs minutes past an hour rather than rolling over', () => {
    expect(formatTime(3725)).toBe('62:05')
  })

  it('reads non-finite and negative input as the start', () => {
    expect(formatTime(Number.NaN)).toBe('0:00')
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00')
    expect(formatTime(-3)).toBe('0:00')
  })
})

describe('pointerFraction', () => {
  it('maps the pointer to its position along the bar', () => {
    expect(pointerFraction(150, 100, 200)).toBe(0.25)
    expect(pointerFraction(300, 100, 200)).toBe(1)
  })

  it('clamps a drag that has left either end', () => {
    expect(pointerFraction(50, 100, 200)).toBe(0)
    expect(pointerFraction(900, 100, 200)).toBe(1)
  })

  it('reads an unlaid-out bar as the start', () => {
    expect(pointerFraction(150, 100, 0)).toBe(0)
    expect(pointerFraction(150, 100, Number.NaN)).toBe(0)
  })
})
