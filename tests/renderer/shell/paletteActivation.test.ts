import { describe, expect, it, vi } from 'vitest'
import type { SearchHit } from '@shared/search'
import {
  activateHit,
  homeTabForKind,
  performSelection,
  type HitActivationDeps
} from '../../../src/renderer/shell/paletteActivation'

/**
 * What a palette selection does: go to where the thing lives, then close. The
 * tab-level half is `performSelection`; the deep half — play this album, open
 * this playlist — is `activateHit`.
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

describe('activateHit', () => {
  function deps(overrides: Partial<HitActivationDeps> = {}): HitActivationDeps {
    return {
      playAlbum: vi.fn(),
      playTrack: vi.fn(),
      openPlaylist: vi.fn(),
      openShow: vi.fn(),
      downloadLatestEpisode: vi.fn(),
      navigate: vi.fn(),
      close: vi.fn(),
      ...overrides
    }
  }

  function hit(kind: SearchHit['kind'], id: number): SearchHit {
    return { kind, id, title: 't', subtitle: null, artworkHash: null, score: 0 }
  }

  it('plays an album by id and closes, without navigating', () => {
    const d = deps()
    activateHit(hit('album', 42), d)
    expect(d.playAlbum).toHaveBeenCalledWith(42)
    expect(d.navigate).not.toHaveBeenCalled()
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('plays a track by id and closes', () => {
    const d = deps()
    activateHit(hit('track', 7), d)
    expect(d.playTrack).toHaveBeenCalledWith(7)
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('opens a playlist on Curate and lands the view on it', () => {
    const d = deps()
    activateHit(hit('playlist', 3), d)
    expect(d.openPlaylist).toHaveBeenCalledWith(3)
    expect(d.navigate).toHaveBeenCalledWith('curate')
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('deep-navigates an artist to its surface', () => {
    const artist = deps()
    activateHit(hit('artist', 1), artist)
    expect(artist.navigate).toHaveBeenCalledWith('library')
    expect(artist.close).toHaveBeenCalledOnce()
  })

  it('downloads a show’s latest episode, opens its tab, and lands on Podcasts', () => {
    const d = deps()
    activateHit(hit('show', 2), d)
    expect(d.downloadLatestEpisode).toHaveBeenCalledWith(2)
    expect(d.openShow).toHaveBeenCalledWith(2)
    expect(d.navigate).toHaveBeenCalledWith('podcasts')
    expect(d.playAlbum).not.toHaveBeenCalled()
    expect(d.close).toHaveBeenCalledOnce()
  })
})
