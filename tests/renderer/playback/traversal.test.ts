import { describe, expect, it } from 'vitest'
import {
  cycleRepeatMode,
  isRepeatMode,
  needsTotal,
  nextIndex,
  previousIndex,
  REPEAT_MODES
} from '../../../src/renderer/playback/traversal'

describe('nextIndex', () => {
  it('walks forwards without repeat', () => {
    expect(nextIndex(0, 3, 'off', 'explicit')).toBe(1)
    expect(nextIndex(1, 3, 'off', 'boundary')).toBe(2)
  })

  it('stops at the last row without repeat', () => {
    expect(nextIndex(2, 3, 'off', 'boundary')).toBeNull()
    expect(nextIndex(2, 3, 'off', 'explicit')).toBeNull()
  })

  it('wraps to the top under repeat-all', () => {
    expect(nextIndex(2, 3, 'all', 'boundary')).toBe(0)
    expect(nextIndex(1, 3, 'all', 'boundary')).toBe(2)
  })

  it('returns the same position at a repeat-one boundary', () => {
    expect(nextIndex(1, 3, 'one', 'boundary')).toBe(1)
    expect(nextIndex(2, 3, 'one', 'boundary')).toBe(2)
  })

  /**
   * The one place §5 rule 7's "overrides everything" is deliberately not taken
   * literally. A mode that trapped the transport on one track would be a bug
   * report, not a feature.
   */
  it('moves on when Next is pressed under repeat-one', () => {
    expect(nextIndex(1, 3, 'one', 'explicit')).toBe(2)
    expect(nextIndex(2, 3, 'one', 'explicit')).toBe(0)
  })

  it('degrades to not wrapping when the length is unknown', () => {
    // `at()` reporting no row is what stops traversal in that case, which is
    // the behaviour that was there before repeat existed.
    expect(nextIndex(2, null, 'off', 'boundary')).toBe(3)
    expect(nextIndex(2, null, 'all', 'boundary')).toBe(3)
  })

  it('wraps from a position the order no longer has', () => {
    // A scan can shorten a playing order underneath the transport.
    expect(nextIndex(9, 3, 'all', 'boundary')).toBe(0)
    expect(nextIndex(9, 3, 'off', 'boundary')).toBeNull()
  })

  it('has nowhere to go in an empty order', () => {
    expect(nextIndex(0, 0, 'all', 'boundary')).toBeNull()
    expect(nextIndex(0, 0, 'off', 'boundary')).toBeNull()
  })

  it('refuses a position that is not a row', () => {
    expect(nextIndex(-1, 3, 'all', 'explicit')).toBeNull()
    expect(nextIndex(1.5, 3, 'all', 'explicit')).toBeNull()
  })
})

describe('previousIndex', () => {
  it('walks backwards', () => {
    expect(previousIndex(2, 3, 'off')).toBe(1)
    expect(previousIndex(1, null, 'off')).toBe(0)
  })

  it('stops at the first row without repeat', () => {
    expect(previousIndex(0, 3, 'off')).toBeNull()
  })

  it('wraps to the last row under either repeat mode', () => {
    expect(previousIndex(0, 3, 'all')).toBe(2)
    expect(previousIndex(0, 3, 'one')).toBe(2)
  })

  it('cannot wrap without a length', () => {
    expect(previousIndex(0, null, 'all')).toBeNull()
  })
})

describe('needsTotal', () => {
  /**
   * The length is a round trip and the boundary path runs on every track, so
   * this is what keeps repeat from costing a query per track when it cannot
   * possibly wrap.
   */
  it('is false whenever traversal cannot run off the end', () => {
    expect(needsTotal('off', 'boundary')).toBe(false)
    expect(needsTotal('off', 'explicit')).toBe(false)
    expect(needsTotal('one', 'boundary')).toBe(false)
  })

  it('is true where wrapping is reachable', () => {
    expect(needsTotal('all', 'boundary')).toBe(true)
    expect(needsTotal('all', 'explicit')).toBe(true)
    expect(needsTotal('one', 'explicit')).toBe(true)
  })

  /**
   * The control on the optimisation, and the reason it is worth having: this
   * is a claim about `nextIndex` made in a separate function, so the two can
   * drift and repeat would silently stop wrapping. Asserted at the last row,
   * which is the only position where knowing the length changes anything.
   *
   * Not literal equality — without the length, repeat-off answers with a
   * position that has no row rather than with `null`, and both of those mean
   * "stop". What matters is whether the length produces a successor that would
   * otherwise be missed.
   */
  it('is true exactly where the length yields a successor that would be missed', () => {
    for (const repeat of REPEAT_MODES) {
      for (const reason of ['boundary', 'explicit'] as const) {
        const withTotal = nextIndex(2, 3, repeat, reason)
        const without = nextIndex(2, null, repeat, reason)
        expect(needsTotal(repeat, reason)).toBe(withTotal !== null && withTotal !== without)
      }
    }
  })
})

describe('cycleRepeatMode', () => {
  it('cycles none, all, one and back', () => {
    expect(cycleRepeatMode('off')).toBe('all')
    expect(cycleRepeatMode('all')).toBe('one')
    expect(cycleRepeatMode('one')).toBe('off')
  })

  it('returns to where it started in one round', () => {
    expect(REPEAT_MODES.map(cycleRepeatMode).map(cycleRepeatMode).map(cycleRepeatMode)).toEqual([
      ...REPEAT_MODES
    ])
  })
})

describe('isRepeatMode', () => {
  it('accepts the modes and nothing else', () => {
    for (const mode of REPEAT_MODES) expect(isRepeatMode(mode)).toBe(true)
    expect(isRepeatMode('ALL')).toBe(false)
    expect(isRepeatMode(1)).toBe(false)
    expect(isRepeatMode(null)).toBe(false)
    expect(isRepeatMode(undefined)).toBe(false)
  })
})
