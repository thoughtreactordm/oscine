import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { Playlist } from '@shared/playlists'
import {
  createPlaylistRail,
  NEW_PLAYLIST_NAME,
  type PlaylistRailCommands,
  type RailKeyEvent
} from '../../../src/renderer/panels/playlistRail'

interface Call {
  name: keyof PlaylistRailCommands
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
 * A rail of four playlists with one of them open, and a recorder behind it.
 *
 * `open` writes `openIds` and `viewedId` the way the store does, so the tests
 * can assert on the resulting viewed set rather than on the call. `playingId` is
 * a ref nothing in the rail can write except through `play`, which is the §5
 * split expressed as a fixture — and the one place the rail is *allowed* to
 * cross it.
 */
function rail(
  playlists: Playlist[] = [
    playlist(1, 'Alpha', 3),
    playlist(2, 'Beta'),
    playlist(3, 'Gamma', 12),
    playlist(4, 'Delta')
  ],
  open: number[] = [1],
  confirmDelete = ref(true)
) {
  const list = ref<Playlist[]>(playlists)
  const openIds = ref<number[]>([...open])
  const viewedId = ref<number | null>(openIds.value[0] ?? null)
  const playingId = ref<number | null>(null)
  const calls: Call[] = []

  const commands: PlaylistRailCommands = {
    open: (playlistId) => {
      calls.push({ name: 'open', args: [playlistId] })
      if (!openIds.value.includes(playlistId)) openIds.value = [...openIds.value, playlistId]
      viewedId.value = playlistId
    },
    create: async (name) => {
      calls.push({ name: 'create', args: [name] })
      const created = playlist(list.value.length + 1, name)
      list.value = [...list.value, created]
      openIds.value = [...openIds.value, created.id]
      viewedId.value = created.id
      return created
    },
    rename: async (playlistId, name) => {
      calls.push({ name: 'rename', args: [playlistId, name] })
    },
    remove: async (playlistId) => {
      calls.push({ name: 'remove', args: [playlistId] })
      list.value = list.value.filter((entry) => entry.id !== playlistId)
      openIds.value = openIds.value.filter((id) => id !== playlistId)
    },
    reorder: async (playlistId, toIndex) => {
      calls.push({ name: 'reorder', args: [playlistId, toIndex] })
    },
    play: (target) => {
      calls.push({ name: 'play', args: [target.id] })
      playingId.value = target.id
    }
  }

  const model = createPlaylistRail({
    playlists: list,
    openIds,
    viewedId,
    playingId,
    confirmDelete,
    commands
  })
  const named = (name: keyof PlaylistRailCommands): Call[] => calls.filter((c) => c.name === name)
  return { model, list, openIds, viewedId, playingId, confirmDelete, calls, named }
}

const key = (event: RailKeyEvent): RailKeyEvent => event

describe('what the rail draws', () => {
  it('is every playlist, open or not', () => {
    const h = rail()
    expect(h.model.rows.value.map((row) => row.playlist.name)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta'
    ])
  })

  it('marks open, viewed and playing as three separate facts', () => {
    const h = rail(undefined, [1, 3])
    h.playingId.value = 3

    const [alpha, beta, gamma] = h.model.rows.value
    expect(alpha).toMatchObject({ isOpen: true, isViewed: true, isPlaying: false })
    // Open and playing, and *not* viewed: the §5 split, visible from the rail.
    expect(gamma).toMatchObject({ isOpen: true, isViewed: false, isPlaying: true })
    expect(beta).toMatchObject({ isOpen: false, isViewed: false, isPlaying: false })
  })
})

/**
 * A roving tabindex with no resting place is a list the Tab key cannot enter,
 * so exactly one row is focusable at all times — including before anyone has
 * pressed an arrow, when `focusedId` is still null.
 */
describe('where the rail is focusable', () => {
  const focusable = (rows: readonly { isFocused: boolean; playlist: { id: number } }[]): number[] =>
    rows.filter((row) => row.isFocused).map((row) => row.playlist.id)

  it('rests on the viewed row before anyone arrows', () => {
    const h = rail(undefined, [3])
    expect(h.model.focusedId.value).toBeNull()
    expect(focusable(h.model.rows.value)).toEqual([3])
  })

  it('rests on the first row when no playlist is viewed', () => {
    const h = rail(undefined, [])
    expect(focusable(h.model.rows.value)).toEqual([1])
  })

  it('follows the arrows once they are used', () => {
    const h = rail()
    h.model.onKeydown(key({ key: 'ArrowDown' }))
    expect(focusable(h.model.rows.value)).toEqual([2])
  })

  it('has no resting place on an empty rail', () => {
    const h = rail([], [])
    expect(focusable(h.model.rows.value)).toEqual([])
  })
})

describe('viewing from the rail', () => {
  it('views a playlist and records it', () => {
    const h = rail()
    h.model.activate(3)
    expect(h.openIds.value).toEqual([1, 3])
    expect(h.viewedId.value).toBe(3)
  })

  it('only views one that is already recorded, adding no second id', () => {
    const h = rail(undefined, [1, 3])
    h.model.activate(3)
    h.model.activate(3)
    expect(h.openIds.value).toEqual([1, 3])
    expect(h.viewedId.value).toBe(3)
  })

  it('views nothing for a playlist that is not there', () => {
    const h = rail()
    h.model.activate(99)
    expect(h.named('open')).toHaveLength(0)
  })

  it('abandons a rename in progress', () => {
    const h = rail()
    h.model.beginRename(1)
    h.model.draft.value = 'Renamed'
    h.model.activate(3)
    expect(h.model.renamingId.value).toBeNull()
    expect(h.named('rename')).toHaveLength(0)
  })
})

describe('playing from the rail', () => {
  it('views the playlist as well as starting it', () => {
    const h = rail()
    h.model.play(3)

    // Order matters to a reader more than to the code: a playlist you can hear
    // and cannot get to would be the failure.
    expect(h.calls.map((call) => call.name)).toEqual(['open', 'play'])
    expect(h.openIds.value).toEqual([1, 3])
    expect(h.viewedId.value).toBe(3)
    expect(h.playingId.value).toBe(3)
  })

  it('views an empty playlist without starting it', () => {
    const h = rail()
    h.model.play(2)
    expect(h.openIds.value).toEqual([1, 2])
    expect(h.named('play')).toHaveLength(0)
    expect(h.playingId.value).toBeNull()
  })
})

describe('creating from the rail', () => {
  it('makes one, views it, and drops straight into its rename', async () => {
    const h = rail()
    await h.model.create()

    expect(h.named('create')[0]?.args).toEqual([NEW_PLAYLIST_NAME])
    expect(h.model.renamingId.value).toBe(5)
    expect(h.model.draft.value).toBe(NEW_PLAYLIST_NAME)
    expect(h.openIds.value).toEqual([1, 5])
  })
})

describe('deleting from the rail', () => {
  it('deletes an empty, silent playlist without asking', async () => {
    const h = rail()
    await h.model.requestDelete(2)
    expect(h.model.deletePrompt.value).toBeNull()
    expect(h.named('remove')[0]?.args).toEqual([2])
  })

  it('confirms before deleting one with entries', async () => {
    const h = rail()
    await h.model.requestDelete(3)

    expect(h.named('remove')).toHaveLength(0)
    const prompt = h.model.deletePrompt.value
    expect(prompt?.playlistId).toBe(3)
    expect(prompt?.title).toContain('Gamma')
    expect(prompt?.message).toContain('12 entries')
    expect(prompt?.stopsPlayback).toBe(false)

    await h.model.confirmDelete()
    expect(h.named('remove')[0]?.args).toEqual([3])
    expect(h.model.deletePrompt.value).toBeNull()
  })

  /**
   * `interface.confirmPlaylistDelete`, off. The prompt is skipped for the
   * playing playlist too — half-honouring the setting would leave the operator
   * who turned it off still being asked, about the one case they can hear.
   */
  it('asks nothing at all when the setting says not to', async () => {
    const confirmDelete = ref(false)
    const h = rail(undefined, undefined, confirmDelete)

    await h.model.requestDelete(3)
    expect(h.model.deletePrompt.value).toBeNull()
    expect(h.named('remove')[0]?.args).toEqual([3])
  })

  it('skips the prompt for the playing playlist too', async () => {
    const h = rail(undefined, undefined, ref(false))
    h.playingId.value = 2
    await h.model.requestDelete(2)
    expect(h.model.deletePrompt.value).toBeNull()
    expect(h.named('remove')[0]?.args).toEqual([2])
  })

  it('starts asking again the moment the setting comes back', async () => {
    const confirmDelete = ref(false)
    const h = rail(undefined, undefined, confirmDelete)
    confirmDelete.value = true

    await h.model.requestDelete(3)
    expect(h.named('remove')).toHaveLength(0)
    expect(h.model.deletePrompt.value?.playlistId).toBe(3)
  })

  it('warns that playback stops when it is the playing one', async () => {
    const h = rail()
    h.playingId.value = 3
    await h.model.requestDelete(3)

    const prompt = h.model.deletePrompt.value
    expect(prompt?.stopsPlayback).toBe(true)
    expect(prompt?.message).toContain('stops playback')
  })

  it('confirms an empty playlist too when it is the playing one', async () => {
    const h = rail()
    h.playingId.value = 2
    await h.model.requestDelete(2)
    expect(h.named('remove')).toHaveLength(0)
    expect(h.model.deletePrompt.value?.stopsPlayback).toBe(true)
  })

  it('deletes nothing when the prompt is dismissed', async () => {
    const h = rail()
    await h.model.requestDelete(3)
    h.model.cancelDelete()
    await h.model.confirmDelete()
    expect(h.named('remove')).toHaveLength(0)
    expect(h.model.deletePrompt.value).toBeNull()
  })

  it('counts one entry in the singular', async () => {
    const h = rail([playlist(1, 'Alpha', 1)], [])
    await h.model.requestDelete(1)
    expect(h.model.deletePrompt.value?.message).toContain('1 entry')
  })

  it('abandons a rename in progress rather than committing it', async () => {
    const h = rail()
    h.model.beginRename(3)
    h.model.draft.value = 'Renamed'
    await h.model.requestDelete(3)

    expect(h.model.renamingId.value).toBeNull()
    expect(h.named('rename')).toHaveLength(0)
  })
})

describe('reordering the rail', () => {
  it('writes the persisted order', async () => {
    const h = rail()
    h.model.beginDrag(1)
    expect(h.model.dragOver(4, 'after')).toBe(true)
    await h.model.drop()
    expect(h.named('reorder')[0]?.args).toEqual([1, 3])
  })

  it('declines a drag it did not start', () => {
    const h = rail()
    expect(h.model.dragOver(2, 'before')).toBe(false)
  })
})

describe('walking the rail from the keyboard', () => {
  it('moves a focus highlight, opening nothing', () => {
    const h = rail()
    expect(h.model.onKeydown(key({ key: 'ArrowDown' }))).toBe('navigate')
    h.model.onKeydown(key({ key: 'ArrowDown' }))
    expect(h.model.focusedId.value).toBe(3)

    // The point of the separate focus: a hundred arrow presses leave one tab.
    expect(h.openIds.value).toEqual([1])
    expect(h.viewedId.value).toBe(1)
  })

  it('starts from the viewed row rather than from the top', () => {
    const h = rail(undefined, [3])
    expect(h.model.focusIndex.value).toBe(2)
    h.model.onKeydown(key({ key: 'ArrowDown' }))
    expect(h.model.focusedId.value).toBe(4)
  })

  it('clamps at both ends rather than wrapping', () => {
    const h = rail()
    h.model.onKeydown(key({ key: 'End' }))
    expect(h.model.focusedId.value).toBe(4)
    h.model.onKeydown(key({ key: 'ArrowDown' }))
    expect(h.model.focusedId.value).toBe(4)

    h.model.onKeydown(key({ key: 'Home' }))
    expect(h.model.focusedId.value).toBe(1)
    h.model.onKeydown(key({ key: 'ArrowUp' }))
    expect(h.model.focusedId.value).toBe(1)
  })

  it('views the focused row with Enter and with Space', () => {
    const h = rail()
    h.model.focusAt(1)
    expect(h.model.onKeydown(key({ key: 'Enter' }))).toBe('open')
    expect(h.openIds.value).toEqual([1, 2])

    h.model.focusAt(3)
    expect(h.model.onKeydown(key({ key: ' ' }))).toBe('open')
    expect(h.openIds.value).toEqual([1, 2, 4])
  })

  it('renames the focused row with F2 and deletes it with Delete', async () => {
    const h = rail()
    h.model.focusAt(2)
    expect(h.model.onKeydown(key({ key: 'F2' }))).toBe('rename')
    expect(h.model.draft.value).toBe('Gamma')

    h.model.cancelRename()
    expect(h.model.onKeydown(key({ key: 'Delete' }))).toBe('delete')
    await Promise.resolve()
    // Gamma has entries, so the destructive key still stops at the prompt.
    expect(h.model.deletePrompt.value?.playlistId).toBe(3)
    expect(h.named('remove')).toHaveLength(0)
  })

  it('is inert while renaming, so the arrows are a caret', () => {
    const h = rail()
    h.model.beginRename(1)
    expect(h.model.onKeydown(key({ key: 'ArrowDown' }))).toBe('none')
  })

  it('leaves modified chords to the shell', () => {
    const h = rail()
    expect(h.model.onKeydown(key({ key: 'ArrowDown', ctrlKey: true }))).toBe('none')
    expect(h.model.onKeydown(key({ key: 'Delete', metaKey: true }))).toBe('none')
  })

  it('has nothing to do on an empty rail', () => {
    const h = rail([], [])
    expect(h.model.focusIndex.value).toBe(-1)
    expect(h.model.onKeydown(key({ key: 'Enter' }))).toBe('none')
    expect(h.model.onKeydown(key({ key: 'Delete' }))).toBe('none')
    expect(h.model.onKeydown(key({ key: 'ArrowDown' }))).toBe('navigate')
    expect(h.model.focusedId.value).toBeNull()
  })
})

describe('renaming from the rail', () => {
  it('commits a changed name once', async () => {
    const h = rail()
    h.model.beginRename(2)
    h.model.draft.value = '  Beta Redux  '
    await h.model.commitRename()
    expect(h.named('rename')[0]?.args).toEqual([2, 'Beta Redux'])
  })

  it('renames a playlist that has no tab, because the rail is not the strip', async () => {
    const h = rail()
    expect(h.model.beginRename(4)).toBe(true)
    h.model.draft.value = 'Delta Redux'
    await h.model.commitRename()
    expect(h.named('rename')[0]?.args).toEqual([4, 'Delta Redux'])
    expect(h.openIds.value).toEqual([1])
  })
})
