import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { Playlist } from '@shared/playlists'
import {
  createPlaylistTabs,
  destinationIndex,
  NEW_PLAYLIST_NAME,
  type PlaylistTabCommands,
  type TabKeyEvent
} from '../../../src/renderer/panels/playlistTabs'

interface Call {
  name: keyof PlaylistTabCommands
  args: unknown[]
}

function playlist(id: number, name: string, trackCount = 0): Playlist {
  return {
    id,
    name,
    crossfadeMs: 0,
    trackCount,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  }
}

/**
 * A bar of three tabs with a recorder behind it.
 *
 * `view` writes the viewed ref exactly like the store does, so a test can assert
 * on the selection rather than on the call, and `playingId` is a ref nothing in
 * the model can write — which is the §5 split expressed as a fixture.
 */
function bar(tabs: Playlist[] = [playlist(1, 'Alpha'), playlist(2, 'Beta'), playlist(3, 'Gamma')]) {
  const list = ref<Playlist[]>(tabs)
  const viewedId = ref<number | null>(tabs[0]?.id ?? null)
  const playingId = ref<number | null>(null)
  const calls: Call[] = []

  const commands: PlaylistTabCommands = {
    view: (playlistId) => {
      calls.push({ name: 'view', args: [playlistId] })
      viewedId.value = playlistId
    },
    create: async (name) => {
      calls.push({ name: 'create', args: [name] })
      const created = playlist(list.value.length + 1, name)
      list.value = [...list.value, created]
      viewedId.value = created.id
      return created
    },
    rename: async (playlistId, name) => {
      calls.push({ name: 'rename', args: [playlistId, name] })
    },
    remove: async (playlistId) => {
      calls.push({ name: 'remove', args: [playlistId] })
      list.value = list.value.filter((tab) => tab.id !== playlistId)
    },
    reorder: async (playlistId, toIndex) => {
      calls.push({ name: 'reorder', args: [playlistId, toIndex] })
    }
  }

  const model = createPlaylistTabs({ tabs: list, viewedId, playingId, commands })
  const named = (name: keyof PlaylistTabCommands): Call[] => calls.filter((c) => c.name === name)
  return { model, list, viewedId, playingId, calls, named }
}

const key = (event: TabKeyEvent): TabKeyEvent => event

describe('the reorder destination', () => {
  const order = [1, 2, 3, 4]

  it('is an index into the list with the dragged tab already removed', () => {
    // Alpha (0) dropped after Delta (3): the visible insertion point is 4, but
    // the main process splices Alpha out first, so the tab it should land after
    // is at 2 by then.
    expect(destinationIndex(order, 1, 4, 'after')).toBe(3)
    expect(destinationIndex(order, 1, 3, 'after')).toBe(2)
    expect(destinationIndex(order, 1, 3, 'before')).toBe(1)
  })

  it('does not shift a leftward drag, which removes from the right of the target', () => {
    expect(destinationIndex(order, 4, 1, 'before')).toBe(0)
    expect(destinationIndex(order, 4, 2, 'after')).toBe(2)
    expect(destinationIndex(order, 3, 1, 'before')).toBe(0)
  })

  it('is null for the gestures that change nothing', () => {
    expect(destinationIndex(order, 2, 2, 'before')).toBeNull()
    expect(destinationIndex(order, 2, 2, 'after')).toBeNull()
    // The gap after my left neighbour is the gap I am already in.
    expect(destinationIndex(order, 2, 1, 'after')).toBeNull()
    expect(destinationIndex(order, 2, 3, 'before')).toBeNull()
  })

  it('is null when either tab is not in the bar', () => {
    expect(destinationIndex(order, 9, 2, 'before')).toBeNull()
    expect(destinationIndex(order, 2, 9, 'before')).toBeNull()
  })
})

describe('dragging a tab', () => {
  it('reorders through the store and clears the indicator', async () => {
    const h = bar()
    h.model.beginDrag(1)
    expect(h.model.dragOver(3, 'after')).toBe(true)
    expect(h.model.dropIndicator(3)).toBe('after')

    await h.model.drop()

    expect(h.named('reorder')[0]?.args).toEqual([1, 2])
    expect(h.model.dropIndicator(3)).toBeNull()
    expect(h.model.dragId.value).toBeNull()
  })

  it('shows no indicator over a gap the tab already occupies', () => {
    const h = bar()
    h.model.beginDrag(2)
    expect(h.model.dragOver(1, 'after')).toBe(true)
    expect(h.model.dropIndicator(1)).toBeNull()
  })

  it('declines a drag it did not start, so a track drop can fall through', () => {
    const h = bar()
    expect(h.model.dragOver(2, 'before')).toBe(false)
    expect(h.model.dropIndicator(2)).toBeNull()
  })

  it('sends nothing when a drag ends outside any drop point', async () => {
    const h = bar()
    h.model.beginDrag(1)
    await h.model.drop()
    expect(h.named('reorder')).toHaveLength(0)
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
    await h.model.requestDelete(1)
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
    h.model.onKeydown(key({ key: 'ArrowLeft' }))
    expect(h.viewedId.value).toBe(1)
  })

  it('jumps to the ends with Home and End', () => {
    const h = bar()
    expect(h.model.onKeydown(key({ key: 'End' }))).toBe('navigate')
    expect(h.viewedId.value).toBe(3)
    h.model.onKeydown(key({ key: 'Home' }))
    expect(h.viewedId.value).toBe(1)
  })

  it('renames with F2 and closes with Delete', async () => {
    const h = bar([playlist(1, 'Alpha'), playlist(2, 'Beta')])
    expect(h.model.onKeydown(key({ key: 'F2' }))).toBe('rename')
    expect(h.model.renamingId.value).toBe(1)
    expect(h.model.draft.value).toBe('Alpha')

    h.model.cancelRename()
    expect(h.model.onKeydown(key({ key: 'Delete' }))).toBe('delete')
    await Promise.resolve()
    expect(h.named('remove')[0]?.args).toEqual([1])
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

  it('opens a new tab straight into its rename', async () => {
    const h = bar()
    await h.model.createTab()
    expect(h.named('create')[0]?.args).toEqual([NEW_PLAYLIST_NAME])
    expect(h.model.renamingId.value).toBe(4)
    expect(h.model.draft.value).toBe(NEW_PLAYLIST_NAME)
  })
})

describe('deleting a tab', () => {
  it('deletes an empty, silent tab without asking', async () => {
    const h = bar()
    await h.model.requestDelete(2)
    expect(h.model.deletePrompt.value).toBeNull()
    expect(h.named('remove')[0]?.args).toEqual([2])
  })

  it('confirms before deleting a tab with entries', async () => {
    const h = bar([playlist(1, 'Alpha'), playlist(2, 'Beta', 12)])
    await h.model.requestDelete(2)

    expect(h.named('remove')).toHaveLength(0)
    const prompt = h.model.deletePrompt.value
    expect(prompt?.playlistId).toBe(2)
    expect(prompt?.title).toContain('Beta')
    expect(prompt?.message).toContain('12 entries')
    expect(prompt?.stopsPlayback).toBe(false)

    await h.model.confirmDelete()
    expect(h.named('remove')[0]?.args).toEqual([2])
    expect(h.model.deletePrompt.value).toBeNull()
  })

  it('warns that playback stops when the tab is the playing one', async () => {
    const h = bar([playlist(1, 'Alpha'), playlist(2, 'Beta', 4)])
    h.playingId.value = 2
    await h.model.requestDelete(2)

    const prompt = h.model.deletePrompt.value
    expect(prompt?.stopsPlayback).toBe(true)
    expect(prompt?.message).toContain('stops playback')
  })

  it('confirms an empty tab too when it is the playing one', async () => {
    const h = bar()
    h.playingId.value = 2
    await h.model.requestDelete(2)
    expect(h.named('remove')).toHaveLength(0)
    expect(h.model.deletePrompt.value?.stopsPlayback).toBe(true)
  })

  it('deletes nothing when the prompt is dismissed', async () => {
    const h = bar([playlist(1, 'Alpha'), playlist(2, 'Beta', 3)])
    await h.model.requestDelete(2)
    h.model.cancelDelete()
    await h.model.confirmDelete()
    expect(h.named('remove')).toHaveLength(0)
    expect(h.model.deletePrompt.value).toBeNull()
  })

  it('counts one entry in the singular', async () => {
    const h = bar([playlist(1, 'Alpha', 1)])
    await h.model.requestDelete(1)
    expect(h.model.deletePrompt.value?.message).toContain('1 entry')
  })

  it('abandons a rename in progress rather than committing it', async () => {
    const h = bar([playlist(1, 'Alpha'), playlist(2, 'Beta', 3)])
    h.model.beginRename(2)
    h.model.draft.value = 'Renamed'
    await h.model.requestDelete(2)

    expect(h.model.renamingId.value).toBeNull()
    expect(h.named('rename')).toHaveLength(0)
  })
})

describe('an empty bar', () => {
  it('has nothing to select and nothing to rename', () => {
    const h = bar([])
    expect(h.model.onKeydown(key({ key: 'ArrowRight' }))).toBe('navigate')
    expect(h.viewedId.value).toBeNull()
    expect(h.model.onKeydown(key({ key: 'F2' }))).toBe('none')
    expect(h.model.onKeydown(key({ key: 'Delete' }))).toBe('none')
    expect(h.named('view')).toHaveLength(0)
  })
})
