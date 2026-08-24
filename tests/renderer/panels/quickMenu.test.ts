import { describe, expect, it, vi } from 'vitest'
import type { AlbumCard } from '../../../src/shared/albums'
import type { FavoriteArtist } from '../../../src/shared/favorites'
import type { Playlist } from '../../../src/shared/playlists'
import {
  activateAlbum,
  activateArtist,
  activatePlaylist,
  loadQuickMenu,
  type QuickMenuActivationDeps,
  type QuickMenuSources
} from '../../../src/renderer/panels/quickMenu'

/**
 * The Quick Menu drawer's data and verbs (D26). The load is three capped reads
 * recomputed on every open; each verb runs the store gesture Library and the
 * palette already use, then closes the drawer.
 */

function playlist(id: number, name: string): Playlist {
  return { id, name, trackCount: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
}

function album(albumId: number, title: string): AlbumCard {
  return { albumId, title, artist: 'a', year: null, artworkHash: null, addedAt: 0 }
}

function artist(id: number, name: string): FavoriteArtist {
  return { id, name, artworkHash: null }
}

describe('loadQuickMenu', () => {
  it('reads all three lists at the given cap and returns them together', async () => {
    const sources: QuickMenuSources = {
      playlists: vi.fn(async () => [playlist(1, 'p')]),
      albums: vi.fn(async () => [album(2, 'al')]),
      artists: vi.fn(async () => [artist(3, 'ar')])
    }

    const lists = await loadQuickMenu(sources, 10)

    expect(sources.playlists).toHaveBeenCalledWith(10)
    expect(sources.albums).toHaveBeenCalledWith(10)
    expect(sources.artists).toHaveBeenCalledWith(10)
    expect(lists.playlists).toEqual([playlist(1, 'p')])
    expect(lists.albums).toEqual([album(2, 'al')])
    expect(lists.artists).toEqual([artist(3, 'ar')])
  })

  it('reads the three channels in parallel, not one after another', async () => {
    let running = 0
    let peak = 0
    const track =
      <T>(value: T) =>
      async (): Promise<T> => {
        running += 1
        peak = Math.max(peak, running)
        await Promise.resolve()
        running -= 1
        return value
      }
    const sources: QuickMenuSources = {
      playlists: track([playlist(1, 'p')]),
      albums: track([album(2, 'al')]),
      artists: track([artist(3, 'ar')])
    }

    await loadQuickMenu(sources, 10)

    expect(peak).toBe(3)
  })

  it('reflects a change between two opens — it is recomputed, not cached', async () => {
    const first: QuickMenuSources = {
      playlists: async () => [],
      albums: async () => [],
      artists: async () => []
    }
    const second: QuickMenuSources = {
      playlists: async () => [playlist(1, 'now favorited')],
      albums: async () => [album(2, 'just imported')],
      artists: async () => [artist(3, 'now favorited')]
    }

    expect(await loadQuickMenu(first, 10)).toEqual({ playlists: [], albums: [], artists: [] })

    const reopened = await loadQuickMenu(second, 10)
    expect(reopened.playlists).toEqual([playlist(1, 'now favorited')])
    expect(reopened.albums).toEqual([album(2, 'just imported')])
    expect(reopened.artists).toEqual([artist(3, 'now favorited')])
  })
})

describe('quick menu activation', () => {
  function deps(overrides: Partial<QuickMenuActivationDeps> = {}): QuickMenuActivationDeps {
    return {
      playPlaylist: vi.fn(),
      playAlbum: vi.fn(),
      playArtist: vi.fn(),
      close: vi.fn(),
      ...overrides
    }
  }

  it('plays a favorite playlist and closes', () => {
    const d = deps()
    activatePlaylist(7, d)
    expect(d.playPlaylist).toHaveBeenCalledWith(7)
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('plays a recent album and closes', () => {
    const d = deps()
    activateAlbum(42, d)
    expect(d.playAlbum).toHaveBeenCalledWith(42)
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('plays everything by a favorite artist and closes', () => {
    const d = deps()
    activateArtist(3, d)
    expect(d.playArtist).toHaveBeenCalledWith(3)
    expect(d.close).toHaveBeenCalledOnce()
  })
})
