import { describe, expect, it } from 'vitest'
import { computed, ref } from 'vue'
import type { Playlist } from '@shared/playlists'
import {
  createPlaylistTabs,
  DISCOVER_TAB,
  FAVORITES_TAB,
  type PlaylistTabCommands,
  type TabKeyEvent,
  type TabStop
} from '../../../src/renderer/panels/playlistTabs'

interface Call {
  name: keyof PlaylistTabCommands
  args: unknown[]
}

function playlist(id: number, name: string, trackCount = 0): Playlist {
  return {
    id,
    name,
    trackCount,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  }
}

/**
 * A bar of three open tabs, over a library of four, with a recorder behind it.
 *
 * The fourth playlist is the point of the fixture: it exists and has no tab, so
 * every assertion about the strip is also an assertion that the strip is a
 * *subset*. `close` and `moveOpen` write `openIds` exactly like the store does,
 * so a test can assert on the resulting strip rather than on the call, and
 * `playingId` is a ref nothing in the model can write — which is the §5 split
 * expressed as a fixture.
 */
function bar(open = [1, 2, 3]) {
  const library = ref<Playlist[]>([
    playlist(1, 'Alpha'),
    playlist(2, 'Beta'),
    playlist(3, 'Gamma'),
    playlist(4, 'Delta, never opened')
  ])
  const openIds = ref<number[]>([...open])
  const viewedId = ref<TabStop>(openIds.value[0] ?? null)
  const playingId = ref<number | null>(null)
  const calls: Call[] = []

  const tabs = computed(() =>
    openIds.value
      .map((id) => library.value.find((entry) => entry.id === id))
      .filter((entry): entry is Playlist => entry !== undefined)
  )

  const commands: PlaylistTabCommands = {
    view: (stop) => {
      calls.push({ name: 'view', args: [stop] })
      // The store's guard: the fixtures are pinned, so only a playlist has to be
      // open to be viewable.
      if (typeof stop !== 'number' || openIds.value.includes(stop)) viewedId.value = stop
    },
    rename: async (playlistId, name) => {
      calls.push({ name: 'rename', args: [playlistId, name] })
    },
    close: (playlistId) => {
      calls.push({ name: 'close', args: [playlistId] })
      const index = openIds.value.indexOf(playlistId)
      if (index === -1) return
      openIds.value = openIds.value.filter((id) => id !== playlistId)
      if (viewedId.value !== playlistId) return
      viewedId.value = openIds.value[Math.min(index, openIds.value.length - 1)] ?? null
    },
    moveOpen: (playlistId, toIndex) => {
      calls.push({ name: 'moveOpen', args: [playlistId, toIndex] })
      const next = openIds.value.filter((id) => id !== playlistId)
      next.splice(toIndex, 0, playlistId)
      openIds.value = next
    }
  }

  const model = createPlaylistTabs({ tabs, viewedId, playingId, commands })
  const named = (name: keyof PlaylistTabCommands): Call[] => calls.filter((c) => c.name === name)
  return { model, library, openIds, viewedId, playingId, calls, named }
}

const key = (event: TabKeyEvent): TabKeyEvent => event

describe('what the strip contains', () => {
  it('is the open playlists, not the library of them', () => {
    const h = bar()
    expect(h.model.tabs.value.map((tab) => tab.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(h.library.value).toHaveLength(4)
  })

  it('follows the open order rather than the library order', () => {
    const h = bar([3, 1])
    expect(h.model.tabs.value.map((tab) => tab.name)).toEqual(['Gamma', 'Alpha'])
  })

  it('can have no tabs at all while playlists exist', () => {
    const h = bar([])
    expect(h.model.tabs.value).toHaveLength(0)
    expect(h.library.value).toHaveLength(4)
  })
})

describe('the Discover fixture', () => {
  it('is the left end of the strip, whatever else is open', () => {
    expect(bar().model.stops.value).toEqual([DISCOVER_TAB, FAVORITES_TAB, 1, 2, 3])
    expect(bar([3, 1]).model.stops.value).toEqual([DISCOVER_TAB, FAVORITES_TAB, 3, 1])
  })

  /**
   * The reason the strip has no empty state any more. `tabs` is empty and the
   * strip is not, because there is always somewhere to be.
   */
  it('is still there with nothing open', () => {
    const h = bar([])
    expect(h.model.tabs.value).toHaveLength(0)
    expect(h.model.stops.value).toEqual([DISCOVER_TAB, FAVORITES_TAB])
    expect(h.model.discoverViewed.value).toBe(true)
  })

  it('is where the view lands when the last tab closes', () => {
    const h = bar([1])
    h.model.close(1)
    expect(h.viewedId.value).toBe(DISCOVER_TAB)
    expect(h.model.discoverViewed.value).toBe(true)
  })

  it('is not viewed while a playlist is, and no playlist is viewed while it is', () => {
    const h = bar()
    expect(h.model.discoverViewed.value).toBe(false)
    expect(h.model.isViewed(1)).toBe(true)

    h.model.select(DISCOVER_TAB)

    expect(h.model.discoverViewed.value).toBe(true)
    expect(h.model.isViewed(1)).toBe(false)
    expect(h.named('view').at(-1)?.args).toEqual([DISCOVER_TAB])
  })

  /**
   * Not a branch anyone wrote — `close` and `rename` need a playlist id, and the
   * fixture has none. Asserted anyway because it is the property the whole
   * `null` representation was chosen for, and a later refactor that gave
   * Discover a synthetic id would break it silently.
   */
  it('cannot be closed or renamed from the keyboard', () => {
    const h = bar()
    h.model.select(DISCOVER_TAB)

    expect(h.model.onKeydown(key({ key: 'Delete' }))).toBe('none')
    expect(h.model.onKeydown(key({ key: 'F2' }))).toBe('none')

    expect(h.openIds.value).toEqual([1, 2, 3])
    expect(h.model.stops.value).toEqual([DISCOVER_TAB, FAVORITES_TAB, 1, 2, 3])
    expect(h.named('close')).toHaveLength(0)
    expect(h.named('rename')).toHaveLength(0)
    expect(h.model.renamingId.value).toBeNull()
  })

  it('cannot be displaced from the left end by a reorder', async () => {
    const h = bar()
    h.model.beginDrag(3)
    h.model.dragOver(1, 'before')
    await h.model.drop()

    // `moveOpen` indexes the playlists, so index 0 is the tab beside Discover
    // rather than Discover's own place.
    expect(h.named('moveOpen')[0]?.args).toEqual([3, 0])
    expect(h.model.stops.value).toEqual([DISCOVER_TAB, FAVORITES_TAB, 3, 1, 2])
  })

  it('plays nothing, so the playing mark stays where the sound is', () => {
    const h = bar()
    h.playingId.value = 2
    h.model.select(DISCOVER_TAB)

    expect(h.model.discoverViewed.value).toBe(true)
    expect(h.model.isPlaying(2)).toBe(true)
    expect(h.playingId.value).toBe(2)
  })
})

describe('closing a tab', () => {
  /**
   * The regression this whole change exists for. `PlaylistTabCommands` has no
   * `remove`, so this is checked at the type level too — but the call log is
   * what a reader will look at, so it is asserted here in full.
   */
  it('takes the tab off the strip and leaves the playlist alone', () => {
    const h = bar()
    h.model.close(2)

    expect(h.model.tabs.value.map((tab) => tab.name)).toEqual(['Alpha', 'Gamma'])
    expect(h.library.value.map((entry) => entry.name)).toContain('Beta')
    expect(h.calls.map((call) => call.name)).toEqual(['close'])
  })

  it('asks for no confirmation, however full or however audible the playlist', () => {
    const h = bar()
    h.library.value = [playlist(1, 'Alpha', 4_312), ...h.library.value.slice(1)]
    h.playingId.value = 1

    h.model.close(1)

    expect(h.named('close')).toHaveLength(1)
    expect(h.openIds.value).toEqual([2, 3])
  })

  it('hands the view to the tab that moved into its place', () => {
    const h = bar()
    h.model.select(2)
    h.model.close(2)
    expect(h.viewedId.value).toBe(3)
  })

  it('hands the view backwards when the last tab closes', () => {
    const h = bar()
    h.model.select(3)
    h.model.close(3)
    expect(h.viewedId.value).toBe(2)
  })

  it('leaves the viewed tab alone when a different one closes', () => {
    const h = bar()
    h.model.select(3)
    h.model.close(1)
    expect(h.viewedId.value).toBe(3)
  })

  it('empties the view when the last tab goes', () => {
    const h = bar([1])
    h.model.close(1)
    expect(h.viewedId.value).toBeNull()
    expect(h.model.tabs.value).toHaveLength(0)
  })

  it('does nothing for a playlist that has no tab', () => {
    const h = bar()
    h.model.close(4)
    expect(h.named('close')).toHaveLength(0)
  })

  it('abandons a rename in progress rather than committing it', () => {
    const h = bar()
    h.model.beginRename(2)
    h.model.draft.value = 'Renamed'
    h.model.close(2)

    expect(h.model.renamingId.value).toBeNull()
    expect(h.named('rename')).toHaveLength(0)
  })

  it('never touches what is playing', () => {
    const h = bar()
    h.playingId.value = 2
    h.model.close(2)
    expect(h.playingId.value).toBe(2)
  })
})

describe('dragging a tab', () => {
  it('rearranges the open set and sends no library reorder', async () => {
    const h = bar()
    h.model.beginDrag(1)
    expect(h.model.dragOver(3, 'after')).toBe(true)
    expect(h.model.dropIndicator(3)).toBe('after')

    await h.model.drop()

    expect(h.named('moveOpen')[0]?.args).toEqual([1, 2])
    expect(h.openIds.value).toEqual([2, 3, 1])
    // The rail owns `playlists.position`. Nothing here may write it.
    expect(h.library.value.map((entry) => entry.id)).toEqual([1, 2, 3, 4])
    expect(h.model.dropIndicator(3)).toBeNull()
    expect(h.model.dragId.value).toBeNull()
  })

  it('declines a drag it did not start, so a track drop can fall through', () => {
    const h = bar()
    expect(h.model.dragOver(2, 'before')).toBe(false)
    expect(h.model.dropIndicator(2)).toBeNull()
  })
})

describe('the viewed and the playing tab', () => {
  it('keeps the playing mark on a tab that is no longer viewed', () => {
    const h = bar()
    h.playingId.value = 1
    expect(h.model.isPlaying(1)).toBe(true)
    expect(h.model.isViewed(1)).toBe(true)

    h.model.select(3)

    // This is the whole visible proof of the §5 split: the marks have come
    // apart, and nothing the strip did touched what is playing.
    expect(h.model.isViewed(3)).toBe(true)
    expect(h.model.isViewed(1)).toBe(false)
    expect(h.model.isPlaying(1)).toBe(true)
    expect(h.playingId.value).toBe(1)
  })

  it('never writes the playing id', async () => {
    const h = bar()
    h.playingId.value = 2
    h.model.select(3)
    h.model.beginDrag(3)
    h.model.dragOver(1, 'before')
    await h.model.drop()
    h.model.close(1)
    expect(h.playingId.value).toBe(2)
  })
})

describe('switching tabs from the keyboard', () => {
  it('walks left and right and stops at the ends', () => {
    const h = bar()
    expect(h.model.onKeydown(key({ key: 'ArrowRight' }))).toBe('navigate')
    expect(h.viewedId.value).toBe(2)
    h.model.onKeydown(key({ key: 'ArrowRight' }))
    h.model.onKeydown(key({ key: 'ArrowRight' }))
    expect(h.viewedId.value).toBe(3)

    h.model.onKeydown(key({ key: 'ArrowLeft' }))
    expect(h.viewedId.value).toBe(2)
    h.model.onKeydown(key({ key: 'ArrowLeft' }))
    expect(h.viewedId.value).toBe(1)

    // Left of the first playlist are the two fixtures, in strip order, and
    // Discover is still an end.
    h.model.onKeydown(key({ key: 'ArrowLeft' }))
    expect(h.viewedId.value).toBe(FAVORITES_TAB)
    h.model.onKeydown(key({ key: 'ArrowLeft' }))
    expect(h.viewedId.value).toBe(DISCOVER_TAB)
    h.model.onKeydown(key({ key: 'ArrowLeft' }))
    expect(h.viewedId.value).toBe(DISCOVER_TAB)
  })

  it('jumps to the ends with Home and End', () => {
    const h = bar()
    expect(h.model.onKeydown(key({ key: 'End' }))).toBe('navigate')
    expect(h.viewedId.value).toBe(3)
    h.model.onKeydown(key({ key: 'Home' }))
    expect(h.viewedId.value).toBe(DISCOVER_TAB)
    h.model.onKeydown(key({ key: 'ArrowRight' }))
    expect(h.viewedId.value).toBe(FAVORITES_TAB)
  })

  it('renames with F2 and closes — never deletes — with Delete', () => {
    const h = bar()
    expect(h.model.onKeydown(key({ key: 'F2' }))).toBe('rename')
    expect(h.model.renamingId.value).toBe(1)
    expect(h.model.draft.value).toBe('Alpha')

    h.model.cancelRename()
    expect(h.model.onKeydown(key({ key: 'Delete' }))).toBe('close')
    expect(h.openIds.value).toEqual([2, 3])
    expect(h.library.value).toHaveLength(4)
  })

  it('is inert while renaming, so the arrows are a caret', () => {
    const h = bar()
    h.model.beginRename(1)
    expect(h.model.onKeydown(key({ key: 'ArrowRight' }))).toBe('none')
    expect(h.viewedId.value).toBe(1)
  })

  it('leaves modified chords to the shell', () => {
    const h = bar()
    expect(h.model.onKeydown(key({ key: 'ArrowRight', ctrlKey: true }))).toBe('none')
    expect(h.model.onKeydown(key({ key: 'ArrowRight', altKey: true }))).toBe('none')
    expect(h.viewedId.value).toBe(1)
  })
})

describe('renaming a tab', () => {
  it('commits a changed name once', async () => {
    const h = bar()
    h.model.beginRename(2)
    h.model.draft.value = '  Beta Redux  '
    await h.model.commitRename()

    expect(h.named('rename')[0]?.args).toEqual([2, 'Beta Redux'])
    expect(h.model.renamingId.value).toBeNull()
  })

  it('sends nothing for a blank name, because the boundary would reject it', async () => {
    const h = bar()
    h.model.beginRename(2)
    h.model.draft.value = '   '
    await h.model.commitRename()
    expect(h.named('rename')).toHaveLength(0)
  })

  it('sends nothing for an unchanged name', async () => {
    const h = bar()
    h.model.beginRename(2)
    await h.model.commitRename()
    expect(h.named('rename')).toHaveLength(0)
  })

  it('discards the draft on cancel', async () => {
    const h = bar()
    h.model.beginRename(2)
    h.model.draft.value = 'Never'
    h.model.cancelRename()
    await h.model.commitRename()
    expect(h.named('rename')).toHaveLength(0)
  })

  it('cannot begin on a playlist that has no tab', () => {
    const h = bar()
    expect(h.model.beginRename(4)).toBe(false)
    expect(h.model.renamingId.value).toBeNull()
  })
})

describe('an empty strip', () => {
  /**
   * "Empty" means no playlist is open, and the strip is still two stops wide.
   * Arrowing right off Discover reaches My Favorites and stops there, and
   * neither fixture has anything for F2 or Delete to act on.
   */
  it('walks the fixtures and has nothing to rename', () => {
    const h = bar([])
    expect(h.model.onKeydown(key({ key: 'ArrowRight' }))).toBe('navigate')
    expect(h.viewedId.value).toBe(FAVORITES_TAB)
    expect(h.model.onKeydown(key({ key: 'ArrowRight' }))).toBe('navigate')
    expect(h.viewedId.value).toBe(FAVORITES_TAB)

    expect(h.model.onKeydown(key({ key: 'F2' }))).toBe('none')
    expect(h.model.onKeydown(key({ key: 'Delete' }))).toBe('none')
    expect(h.named('rename')).toHaveLength(0)
    expect(h.named('close')).toHaveLength(0)
  })
})
