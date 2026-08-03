import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { Playlist } from '../../../src/shared/playlists'
import type { ListFavoritesQuery, ListFavoritesResult } from '../../../src/shared/favorites'
import type { Track } from '../../../src/shared/library'
import { createFavoritesWindow } from '../../../src/renderer/panels/favoritesWindow'
import { createPlaylistRail } from '../../../src/renderer/panels/playlistRail'
import type { PlaylistRailCommands } from '../../../src/renderer/panels/playlistRail'
import {
  createPlaylistTabs,
  DISCOVER_TAB,
  FAVORITES_TAB,
  type PlaylistTabCommands,
  type TabStop
} from '../../../src/renderer/panels/playlistTabs'

/**
 * W10-7's three properties, at the layer that actually holds them.
 *
 * There is no component mounting in this repo and these do not need it: "the
 * entry is pinned", "it cannot be reordered" and "it survives the collection
 * going empty" are all facts about the stop set, the rail's row set and the
 * window — none of which needs a browser to be wrong in.
 *
 * The strongest version of the third property is not asserted here because it
 * cannot be: `beginDrag`, `dragOver` and `requestDelete` all take a `number`, so
 * handing them `FAVORITES_TAB` does not compile. What is asserted is the part a
 * refactor could still break — that the fixture is absent from the sequences
 * those verbs index into.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function playlist(id: number, name: string, trackCount = 0): Playlist {
  return {
    id,
    name,
    trackCount,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z'
  }
}

function track(id: number): Track {
  return {
    id,
    rootId: 1,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: id,
    discNo: null,
    year: null,
    durationSec: 120,
    codec: 'flac',
    encodedBytes: 12_000_000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    playCount: 0,
    lastPlayedAt: null,
    favorite: true,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** The strip, with the store's own `view` guard behind it. */
function strip(open = [1, 2, 3]) {
  const library = ref<Playlist[]>([playlist(1, 'Alpha'), playlist(2, 'Beta'), playlist(3, 'Gamma')])
  const openIds = ref<number[]>([...open])
  const viewedStop = ref<TabStop>(openIds.value[0] ?? null)
  const moves: { playlistId: number; toIndex: number }[] = []

  const tabs = computed(() =>
    openIds.value
      .map((id) => library.value.find((entry) => entry.id === id))
      .filter((entry): entry is Playlist => entry !== undefined)
  )

  const commands: PlaylistTabCommands = {
    // `usePlaylistsStore().view`: the fixtures are pinned, so only a playlist
    // has to be open to be viewable.
    view: (stop) => {
      if (typeof stop !== 'number' || openIds.value.includes(stop)) viewedStop.value = stop
    },
    rename: async () => {},
    close: (playlistId) => {
      const index = openIds.value.indexOf(playlistId)
      if (index === -1) return
      openIds.value = openIds.value.filter((id) => id !== playlistId)
      if (viewedStop.value !== playlistId) return
      viewedStop.value = openIds.value[Math.min(index, openIds.value.length - 1)] ?? null
    },
    moveOpen: (playlistId, toIndex) => {
      moves.push({ playlistId, toIndex })
      const next = openIds.value.filter((id) => id !== playlistId)
      next.splice(toIndex, 0, playlistId)
      openIds.value = next
    }
  }

  const model = createPlaylistTabs({
    tabs,
    viewedId: viewedStop,
    playingId: ref<number | null>(null),
    commands
  })
  return { model, library, openIds, viewedStop, moves }
}

/** The rail, which knows nothing about the pinned entry — see the assertions. */
function rail() {
  const list = ref<Playlist[]>([playlist(1, 'Alpha'), playlist(2, 'Beta'), playlist(3, 'Gamma')])
  const reorders: { playlistId: number; toIndex: number }[] = []

  const commands: PlaylistRailCommands = {
    open: () => {},
    create: async (name) => playlist(list.value.length + 1, name),
    rename: async () => {},
    remove: async () => {},
    reorder: async (playlistId, toIndex) => {
      reorders.push({ playlistId, toIndex })
    },
    play: () => {}
  }

  const model = createPlaylistRail({
    playlists: () => list.value,
    openIds: () => [],
    viewedId: () => null,
    playingId: () => null,
    confirmDelete: () => false,
    commands
  })
  return { model, list, reorders }
}

/** A favorites window over a collection whose size the test can change. */
function favorites(total: number) {
  let size = total
  const fetchPage = vi.fn(async (query: ListFavoritesQuery): Promise<ListFavoritesResult> => ({
    tracks: Array.from(
      { length: Math.max(0, Math.min(query.limit, size - query.offset)) },
      (_, i) => track(query.offset + i)
    ),
    total: size
  }))
  const fetchIdPage = vi.fn(async (query: { offset: number; limit: number }) => ({
    ids: Array.from(
      { length: Math.max(0, Math.min(query.limit, size - query.offset)) },
      (_, i) => query.offset + i
    ),
    total: size
  }))

  const model = createFavoritesWindow({ fetchPage, fetchIdPage, pageSize: 50 })
  return {
    model,
    unfavoriteAll: (): void => {
      size = 0
    }
  }
}

describe('the pinned My Favorites entry', () => {
  /**
   * The card's first property. "Present with zero favorites" is a claim about
   * the *stop set*, which is why it holds: the fixture is in `stops`
   * unconditionally, so nothing about the collection's contents can take it off
   * the strip. What the operator sees inside it is the window's empty total,
   * which the pane renders as an empty state rather than as an absence.
   */
  it('is there with zero favorites, and the emptiness is the collection, not the entry', async () => {
    const s = strip()
    const f = favorites(0)
    f.model.ensureRange(0, 5)
    await flush()

    expect(s.model.stops.value).toContain(FAVORITES_TAB)
    expect(f.model.total.value).toBe(0)
    expect(f.model.error.value).toBeNull()

    s.model.select(FAVORITES_TAB)
    expect(s.model.favoritesViewed.value).toBe(true)
  })

  /**
   * The card's second property. Un-hearting the last row empties the collection
   * and must not take the entry with it — including while the operator is
   * looking at it, which is the case that would strand them.
   */
  it('stays in place, and stays viewed, when the last favorite is removed', async () => {
    const s = strip()
    const f = favorites(1)
    f.model.ensureRange(0, 5)
    await flush()

    s.model.select(FAVORITES_TAB)
    expect(f.model.total.value).toBe(1)

    f.model.forget([0])
    f.unfavoriteAll()
    f.model.reload()
    await flush()

    expect(f.model.total.value).toBe(0)
    expect(s.model.stops.value).toContain(FAVORITES_TAB)
    expect(s.model.favoritesViewed.value).toBe(true)
    expect(s.viewedStop.value).toBe(FAVORITES_TAB)
  })

  /**
   * The card's third property, in the rail. The rail's rows *are* the reorder's
   * index space — `reorder(playlistId, toIndex)` is an index into them — and the
   * pinned entry is not one of them. It is drawn outside the list entirely, so
   * there is nothing to exclude and nothing that could stop excluding it.
   */
  it('is not one of the rail rows a reorder drag indexes into', async () => {
    const r = rail()

    expect(r.model.rows.value.map((row) => row.playlist.id)).toEqual([1, 2, 3])

    r.model.beginDrag(3)
    r.model.dragOver(1, 'before')
    await r.model.drop()

    // Index 0 is the first *playlist*, because that is the only sequence there
    // is here. Nothing pinned occupies a place in it.
    expect(r.reorders).toEqual([{ playlistId: 3, toIndex: 0 }])
    expect(r.model.rows.value.map((row) => row.playlist.id)).toEqual([1, 2, 3])
  })

  /** The same property in the strip: a tab reorder cannot displace either fixture. */
  it('cannot be displaced from the left end of the strip by a tab reorder', async () => {
    const s = strip()

    s.model.beginDrag(3)
    s.model.dragOver(1, 'before')
    await s.model.drop()

    expect(s.moves).toEqual([{ playlistId: 3, toIndex: 0 }])
    expect(s.model.stops.value).toEqual([DISCOVER_TAB, FAVORITES_TAB, 3, 1, 2])
  })

  /**
   * Pinned means pinned. A playlist has to be open to be viewed, because the
   * pane it opens must be navigable back to; the fixtures have no tab to have
   * first, so an operator on My Favorites with nothing else open stays there.
   */
  it('is viewable with no playlist open at all', () => {
    const s = strip([])

    s.model.select(FAVORITES_TAB)

    expect(s.model.favoritesViewed.value).toBe(true)
    expect(s.model.tabs.value).toHaveLength(0)
  })

  /**
   * Creating, reordering and deleting playlists around it leave it alone —
   * the card's "done when", stated against the stop set it is a fact about.
   */
  it('survives playlists being opened, reordered and closed around it', async () => {
    const s = strip()
    s.model.select(FAVORITES_TAB)

    s.model.beginDrag(2)
    s.model.dragOver(1, 'before')
    await s.model.drop()
    s.model.close(1)
    s.model.close(2)
    s.model.close(3)

    expect(s.model.tabs.value).toHaveLength(0)
    expect(s.model.stops.value).toEqual([DISCOVER_TAB, FAVORITES_TAB])
    expect(s.model.favoritesViewed.value).toBe(true)
  })

  /**
   * The type-level guarantee, said out loud once. Every destructive verb in the
   * strip takes a `number`, so the fixture cannot reach one — F2 and Delete on
   * it are `none` rather than a branch someone remembered to write.
   */
  it('cannot be renamed or closed from the keyboard', () => {
    const s = strip()
    s.model.select(FAVORITES_TAB)

    expect(s.model.onKeydown({ key: 'F2' })).toBe('none')
    expect(s.model.onKeydown({ key: 'Delete' })).toBe('none')
    expect(s.model.renamingId.value).toBeNull()
    expect(s.openIds.value).toEqual([1, 2, 3])
  })
})
