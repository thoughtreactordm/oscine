import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import type { Playlist } from '../../../src/shared/playlists'
import {
  addToPlaylistLabel,
  createAddToPlaylist,
  type AddTarget
} from '../../../src/renderer/panels/addToPlaylist'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function playlist(id: number, name: string): Playlist {
  return {
    id,
    name,
    trackCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

interface HarnessOptions {
  playlists?: Playlist[]
  create?: (name: string) => Promise<Playlist | null>
  addTracks?: (playlistId: number, trackIds: readonly number[]) => Promise<boolean>
}

function harness(options: HarnessOptions = {}) {
  const playlists = ref<Playlist[]>(options.playlists ?? [playlist(1, 'Mix'), playlist(2, 'Drive')])
  const created: string[] = []
  const added: Array<{ playlistId: number; trackIds: readonly number[] }> = []
  let nextId = 100

  const model = createAddToPlaylist({
    playlists: () => playlists.value,
    create:
      options.create ??
      ((name) => {
        const made = playlist(++nextId, name)
        created.push(name)
        playlists.value = [...playlists.value, made]
        return Promise.resolve(made)
      }),
    addTracks:
      options.addTracks ??
      ((playlistId, trackIds) => {
        added.push({ playlistId, trackIds })
        return Promise.resolve(true)
      })
  })

  return { model, playlists, created, added }
}

function target(overrides: Partial<AddTarget> = {}): AddTarget {
  return {
    count: 1,
    trackIds: () => Promise.resolve([11, 12, 13]),
    ...overrides
  }
}

/** The submenu's children, as plain labels. */
function labels(item: ContextMenuItem): string[] {
  const children = (item.children ?? []) as ContextMenuItem[]
  return children.map((child) => (child.type === 'separator' ? '---' : (child.label ?? '')))
}

describe('the add-to-playlist label', () => {
  it('says nothing about the count for a single thing', () => {
    expect(addToPlaylistLabel(1)).toBe('Add to playlist')
    expect(addToPlaylistLabel(1, 'albums')).toBe('Add to playlist')
  })

  it('names what was selected, not what will be added', () => {
    expect(addToPlaylistLabel(4)).toBe('Add 4 tracks to playlist')
    expect(addToPlaylistLabel(6, 'albums')).toBe('Add 6 albums to playlist')
    expect(addToPlaylistLabel(4312, 'artists')).toBe('Add 4,312 artists to playlist')
  })
})

describe('the add-to-playlist submenu', () => {
  it('lists every playlist and ends at a new one', () => {
    const h = harness()
    expect(labels(h.model.menuItem(target()))).toEqual(['Mix', 'Drive', '---', 'New playlist…'])
  })

  it('offers the new one alone when there are no playlists', () => {
    const h = harness({ playlists: [] })
    // The old menu offered a disabled "No playlists yet" here, which left the
    // operator with a submenu and nothing in it they could click.
    expect(labels(h.model.menuItem(target()))).toEqual(['New playlist…'])
  })

  it('follows the playlists it was given', () => {
    const h = harness()
    h.playlists.value = [playlist(9, 'Later')]
    expect(labels(h.model.menuItem(target()))).toEqual(['Later', '---', 'New playlist…'])
  })
})

describe('adding to an existing playlist', () => {
  it('resolves the target and adds in one call', async () => {
    const h = harness()
    await h.model.addTo(2, target({ count: 3 }))
    expect(h.added).toEqual([{ playlistId: 2, trackIds: [11, 12, 13] }])
    expect(h.model.outcome.value).toMatchObject({
      kind: 'added',
      message: 'Added 3 tracks to “Drive”.'
    })
  })

  it('reports rather than throws when the target cannot be resolved', async () => {
    const h = harness()
    await h.model.addTo(1, target({ trackIds: () => Promise.reject(new Error('gone')) }))
    expect(h.added).toEqual([])
    expect(h.model.outcome.value?.kind).toBe('failed')
  })

  it('reports an empty target instead of a silent no-op', async () => {
    const h = harness()
    await h.model.addTo(1, target({ trackIds: () => Promise.resolve([]) }))
    expect(h.added).toEqual([])
    expect(h.model.outcome.value).toMatchObject({
      kind: 'failed',
      message: 'There was nothing to add to “Mix”.'
    })
  })

  it('reports a refused add', async () => {
    const h = harness({ addTracks: () => Promise.resolve(false) })
    await h.model.addTo(1, target())
    expect(h.model.outcome.value?.kind).toBe('failed')
  })

  it('makes two adds two events', async () => {
    const h = harness()
    await h.model.addTo(1, target())
    const first = h.model.outcome.value?.seq
    await h.model.addTo(1, target())
    expect(h.model.outcome.value?.seq).toBe((first ?? 0) + 1)
  })
})

describe('the new-playlist prompt', () => {
  it('opens with the target described and its name suggested', () => {
    const h = harness()
    h.model.beginNew(target({ count: 6, unit: 'albums', suggestedName: 'Rubber Soul' }))
    expect(h.model.open.value).toBe(true)
    expect(h.model.draft.value).toBe('Rubber Soul')
    expect(h.model.count.value).toBe(6)
    expect(h.model.unit.value).toBe('albums')
  })

  it('starts blank when the target has no name of its own', () => {
    const h = harness()
    h.model.beginNew(target({ count: 40 }))
    expect(h.model.draft.value).toBe('')
    expect(h.model.unit.value).toBe('tracks')
  })

  it('closes before the work is done, so browsing carries on', async () => {
    let release: (playlist: Playlist) => void = () => {}
    const h = harness({
      create: () => new Promise<Playlist | null>((resolve) => (release = resolve))
    })
    h.model.beginNew(target())
    h.model.draft.value = 'Evening'

    const done = h.model.confirm()
    // Synchronously, before anything has been awaited: the dialog is gone.
    expect(h.model.open.value).toBe(false)

    // The ids resolve first, so `create` — and with it `release` — is a tick away.
    await flush()
    release(playlist(7, 'Evening'))
    await done
    expect(h.added).toEqual([{ playlistId: 7, trackIds: [11, 12, 13] }])
  })

  it('creates the playlist and fills it', async () => {
    const h = harness()
    h.model.beginNew(target({ count: 3 }))
    h.model.draft.value = '  Evening  '
    await h.model.confirm()

    expect(h.created).toEqual(['Evening'])
    expect(h.added).toEqual([{ playlistId: 101, trackIds: [11, 12, 13] }])
    expect(h.model.outcome.value).toMatchObject({
      kind: 'added',
      message: 'Created “Evening” with 3 tracks.'
    })
  })

  it('treats a blank name as a cancel', async () => {
    const h = harness()
    h.model.beginNew(target())
    h.model.draft.value = '   '
    await h.model.confirm()

    expect(h.model.open.value).toBe(false)
    expect(h.created).toEqual([])
    expect(h.model.outcome.value).toBeNull()
  })

  it('leaves no playlist behind when the target cannot be resolved', async () => {
    const h = harness()
    h.model.beginNew(target({ trackIds: () => Promise.reject(new Error('gone')) }))
    h.model.draft.value = 'Evening'
    await h.model.confirm()

    // The ids are resolved first precisely so this cannot leave an empty
    // playlist named after an add that never happened.
    expect(h.created).toEqual([])
    expect(h.model.outcome.value?.kind).toBe('failed')
  })

  it('reports a playlist that could not be created', async () => {
    const h = harness({ create: () => Promise.resolve(null) })
    h.model.beginNew(target())
    h.model.draft.value = 'Evening'
    await h.model.confirm()

    expect(h.added).toEqual([])
    expect(h.model.outcome.value).toMatchObject({
      kind: 'failed',
      message: '“Evening” could not be created.'
    })
  })

  it('says so when the playlist was made but the tracks did not land', async () => {
    const h = harness({ addTracks: () => Promise.resolve(false) })
    h.model.beginNew(target())
    h.model.draft.value = 'Evening'
    await h.model.confirm()
    expect(h.model.outcome.value).toMatchObject({
      kind: 'failed',
      message: '“Evening” was created, but those tracks could not be added.'
    })
  })

  it('cancelling forgets the target, so a later confirm does nothing', async () => {
    const h = harness()
    h.model.beginNew(target())
    h.model.cancel()
    h.model.draft.value = 'Evening'
    await h.model.confirm()
    expect(h.created).toEqual([])
  })

  it('reaches the prompt from the submenu', async () => {
    const h = harness()
    const children = (h.model.menuItem(target({ suggestedName: 'Ella' })).children ??
      []) as ContextMenuItem[]
    const create = children.at(-1)
    create?.onSelect?.(new Event('select'))
    await flush()

    expect(h.model.open.value).toBe(true)
    expect(h.model.draft.value).toBe('Ella')
  })

  it('reaches an existing playlist from the submenu', async () => {
    const h = harness()
    const children = (h.model.menuItem(target()).children ?? []) as ContextMenuItem[]
    children[1]?.onSelect?.(new Event('select'))
    await flush()

    expect(h.added).toEqual([{ playlistId: 2, trackIds: [11, 12, 13] }])
  })
})
