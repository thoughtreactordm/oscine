import { describe, expect, it } from 'vitest'
import { dayKey, tieBreak } from '../../../../src/main/library/discover/hash'

describe('dayKey', () => {
  it('is the UTC calendar date of the instant', () => {
    expect(dayKey(Date.UTC(2024, 5, 15, 12, 0, 0))).toBe('2024-06-15')
    expect(dayKey(Date.UTC(2024, 5, 15, 0, 0, 0))).toBe('2024-06-15')
    expect(dayKey(Date.UTC(2024, 5, 15, 23, 59, 59))).toBe('2024-06-15')
  })

  it('rolls at UTC midnight, not at local midnight', () => {
    expect(dayKey(Date.UTC(2024, 5, 15, 23, 59, 59) + 1000)).toBe('2024-06-16')
  })
})

describe('tieBreak', () => {
  it('is stable for the same recipe, entity and day', () => {
    expect(tieBreak('for-you', 42, '2024-06-15')).toBe(tieBreak('for-you', 42, '2024-06-15'))
  })

  it('changes when the UTC day changes', () => {
    expect(tieBreak('for-you', 42, '2024-06-15')).not.toBe(tieBreak('for-you', 42, '2024-06-16'))
  })

  it('changes across recipes and entities', () => {
    const base = tieBreak('for-you', 42, '2024-06-15')
    expect(tieBreak('unplayed', 42, '2024-06-15')).not.toBe(base)
    expect(tieBreak('for-you', 43, '2024-06-15')).not.toBe(base)
  })
})
