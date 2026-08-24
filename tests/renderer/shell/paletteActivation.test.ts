import { describe, expect, it, vi } from 'vitest'
import { homeTabForKind, performSelection } from '../../../src/renderer/shell/paletteActivation'

/**
 * What a palette selection does: go to where the thing lives, then close. Tab
 * -level only this card — deep targets are W13-7.
 */

describe('homeTabForKind', () => {
  it('routes each kind to its home tab', () => {
    expect(homeTabForKind('playlist')).toBe('curate')
    expect(homeTabForKind('show')).toBe('podcasts')
    expect(homeTabForKind('album')).toBe('library')
    expect(homeTabForKind('artist')).toBe('library')
    expect(homeTabForKind('track')).toBe('library')
  })
})

describe('performSelection', () => {
  it('navigates then closes the palette', () => {
    const calls: string[] = []
    const navigate = vi.fn(() => calls.push('navigate'))
    const close = vi.fn(() => calls.push('close'))

    performSelection({ tab: 'curate' }, { navigate, close })

    expect(navigate).toHaveBeenCalledWith('curate')
    expect(close).toHaveBeenCalledOnce()
    // The palette is gone by the time the destination paints.
    expect(calls).toEqual(['navigate', 'close'])
  })
})
