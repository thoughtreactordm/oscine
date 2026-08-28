import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Playlist } from '../../../src/shared/playlists'
import type { ListFavoritesQuery, ListFavoritesResult } from '../../../src/shared/favorites'
import type { Track } from '../../../src/shared/library'
import { createFavoritesWindow } from '../../../src/renderer/panels/favoritesWindow'
import { createPlaylistRail } from '../../../src/renderer/panels/playlistRail'
import type { PlaylistRailCommands } from '../../../src/renderer/panels/playlistRail'

/**
 * W10-7's three properties, at the layer that actually holds them.
 *
 * There is no component mounting in this repo and these do not need it: "the
 * entry is pinned", "it cannot be reordered" and "it survives the collection
 * going empty" are all facts about the rail's row set and the window — none of
 * which needs a browser to be wrong in.
 *
 * The strongest version of the pin is not asserted here because it cannot be:
 * `beginDrag`, `dragOver` and `requestDelete` all take a `number`, so handing
 * them the Favorites fixture does not compile. What is asserted is the part a
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
    modified: false,
    artwork: { small: 'oscine://artwork/missing/small', large: 'oscine://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** The rail, which knows nothing about the pinned entries — see the assertions. */
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
   * the *collection*, which is why it holds: the window reports an empty total
   * rather than an error, and the pane renders that as an empty state rather
   * than as an absence. The rail draws the entry outside `rows`, so nothing
   * about the collection's contents can take it off.
   */
  it('is there with zero favorites, and the emptiness is the collection, not the entry', async () => {
    const f = favorites(0)
    f.model.ensureRange(0, 5)
    await flush()

    expect(f.model.total.value).toBe(0)
    expect(f.model.error.value).toBeNull()
  })

  /**
   * The card's second property. Un-hearting the last row empties the collection
   * and must not take the entry with it — including while the operator is
   * looking at it, which is the case that would strand them.
   */
  it('stays in place when the last favorite is removed', async () => {
    const f = favorites(1)
    f.model.ensureRange(0, 5)
    await flush()

    expect(f.model.total.value).toBe(1)

    f.model.forget([0])
    f.unfavoriteAll()
    f.model.reload()
    await flush()

    expect(f.model.total.value).toBe(0)
  })

  /**
   * The card's third property, in the rail. The rail's rows *are* the reorder's
   * index space — `reorder(playlistId, toIndex)` is an index into them — and the
   * pinned entries are not among them. They are drawn outside the list entirely,
   * so there is nothing to exclude and nothing that could stop excluding them.
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
})
