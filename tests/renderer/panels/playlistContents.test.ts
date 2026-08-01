import { describe, expect, it, vi } from 'vitest'
import {
  createPlaylistContents,
  insertionFor,
  type PlaylistContentsDeps
} from '../../../src/renderer/panels/playlistContents'
import type { RowDragPayload } from '../../../src/renderer/panels/trackDrag'
import type { PlaylistInsertion } from '../../../src/shared/playlists'

/**
 * The contents pane's rules, with no DOM and no Pinia.
 *
 * The playlist under test is ten rows whose entry ids are 100, 101, … and whose
 * *tracks* repeat — entry 100 and entry 105 hold the same track. Every assertion
 * about identity below is really an assertion that the pane never fell back to
 * the track id (D12).
 */

const ENTRY_IDS = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]

function harness(
  options: { selected?: number[]; playlistId?: number | null; confirmRemoval?: boolean } = {}
) {
  const selected = new Set(options.selected ?? [])
  const calls: string[] = []
  let dragging: RowDragPayload | null = null

  const record =
    (name: string) =>
    (...args: unknown[]) => {
      void args
      calls.push(name)
      return Promise.resolve()
    }

  const addTracks = vi.fn(record('addTracks'))
  const moveEntries = vi.fn(record('moveEntries'))
  const removeEntries = vi.fn(record('removeEntries'))

  const deps: PlaylistContentsDeps = {
    playlistId: () => (options.playlistId === undefined ? 7 : options.playlistId),
    entryIdAt: (index) => ENTRY_IDS[index],
    isSelectedAt: (index) => selected.has(index),
    selectionCount: () => selected.size,
    resolveSelection: () =>
      Promise.resolve([...selected].sort((a, b) => a - b).map((index) => ENTRY_IDS[index]!)),
    activeDrag: () => dragging,
    beginDrag: (payload) => {
      dragging = payload
    },
    endDrag: () => {
      dragging = null
    },
    confirmRemoval: options.confirmRemoval ?? false,
    commands: { addTracks, moveEntries, removeEntries }
  }

  return {
    model: createPlaylistContents(deps),
    calls,
    addTracks,
    moveEntries,
    removeEntries,
    dragged: (): RowDragPayload | null => dragging,
    /** A drag this pane did not start: the library's, or another playlist's. */
    arriveWith: (payload: RowDragPayload): void => {
      dragging = payload
    }
  }
}

/** A drag that came from the library list: track ids, no playlist. */
function libraryDrag(trackIds: number[]): RowDragPayload {
  return {
    count: trackIds.length,
    playlistId: null,
    trackIds: () => Promise.resolve(trackIds),
    entryIds: null
  }
}

describe('drop position', () => {
  const at = (index: number | null, side: 'before' | 'after'): PlaylistInsertion =>
    insertionFor({ index, side }, (i) => ENTRY_IDS[i])

  it('anchors on the neighbour it was dropped against, on the side it was dropped', () => {
    expect(at(0, 'before')).toEqual({ at: 'before', entryId: 100 })
    expect(at(4, 'after')).toEqual({ at: 'after', entryId: 104 })
  })

  it('falls to the end for the empty area and for a row whose page is not loaded', () => {
    expect(at(null, 'after')).toEqual({ at: 'end' })
    // A skeleton row has no id to anchor against, and guessing one would land
    // the drop somewhere the user did not point at.
    expect(insertionFor({ index: 3, side: 'before' }, () => undefined)).toEqual({ at: 'end' })
  })
})

describe('adding from the library', () => {
  it('sends one batched call however many rows were dropped', async () => {
    const scene = harness()
    const trackIds = Array.from({ length: 5_000 }, (_, index) => index + 1)
    scene.arriveWith(libraryDrag(trackIds))

    expect(scene.model.dragOver(2, 'after')).toBe(true)
    await scene.model.drop()

    // 5,000 rows, one request. The batch is the whole reason
    // `AddTracksToPlaylistRequest` takes a list.
    expect(scene.addTracks).toHaveBeenCalledTimes(1)
    expect(scene.addTracks).toHaveBeenCalledWith(trackIds, { at: 'after', entryId: 102 })
  })

  it('preserves the order the rows were shown in', async () => {
    const scene = harness()
    scene.arriveWith(libraryDrag([9, 4, 7]))

    scene.model.dragOver(0, 'before')
    await scene.model.drop()

    expect(scene.addTracks).toHaveBeenCalledWith([9, 4, 7], { at: 'before', entryId: 100 })
  })

  it('does nothing for a drop that was never dragged over the pane', async () => {
    const scene = harness()
    scene.arriveWith(libraryDrag([1]))

    await scene.model.drop()

    expect(scene.calls).toEqual([])
  })
})

describe('reordering', () => {
  it('carries the whole selection when the drag starts on a selected row', async () => {
    const scene = harness({ selected: [1, 2, 6] })

    expect(scene.model.beginDrag(2)).toBe(true)
    expect(scene.dragged()?.count).toBe(3)
    expect(scene.dragged()?.playlistId).toBe(7)
    // A reorder is expressed in entry ids and only in entry ids.
    expect(scene.dragged()?.trackIds).toBeNull()
    await expect(scene.dragged()?.entryIds?.()).resolves.toEqual([101, 102, 106])

    scene.model.dragOver(8, 'after')
    await scene.model.drop()

    expect(scene.moveEntries).toHaveBeenCalledTimes(1)
    expect(scene.moveEntries).toHaveBeenCalledWith([101, 102, 106], { at: 'after', entryId: 108 })
  })

  it('carries one row when the drag starts off the selection, without disturbing it', async () => {
    const scene = harness({ selected: [1, 2] })

    expect(scene.model.beginDrag(9)).toBe(true)
    expect(scene.dragged()?.count).toBe(1)

    scene.model.dragOver(0, 'before')
    await scene.model.drop()

    // One entry id, so main writes one position — the card's "one row" claim
    // ends at exactly this request. See the store test that proves the rest.
    expect(scene.moveEntries).toHaveBeenCalledWith([109], { at: 'before', entryId: 100 })
  })

  it('moves the entry, not both copies of its track', async () => {
    const scene = harness({ selected: [5] })

    scene.model.beginDrag(5)
    scene.model.dragOver(0, 'before')
    await scene.model.drop()

    // Entry 105 holds the same track as entry 100 and is the only id sent.
    expect(scene.moveEntries).toHaveBeenCalledWith([105], { at: 'before', entryId: 100 })
  })

  it('draws the marker on the row and edge under the pointer, and clears it on drop', async () => {
    const scene = harness({ selected: [0] })
    scene.model.beginDrag(0)

    scene.model.dragOver(3, 'before')
    expect(scene.model.dropIndicator(3)).toBe('before')
    expect(scene.model.dropIndicator(4)).toBeNull()

    scene.model.dragOver(3, 'after')
    expect(scene.model.dropIndicator(3)).toBe('after')

    scene.model.dragOver(null, 'after')
    expect(scene.model.dropIndicator(3)).toBeNull()
    expect(scene.model.droppingAtEnd.value).toBe(true)

    await scene.model.drop()
    expect(scene.model.dropIndicator(3)).toBeNull()
    expect(scene.model.droppingAtEnd.value).toBe(false)
  })

  it('refuses a drag from another playlist rather than half-accepting it', async () => {
    const scene = harness()
    scene.arriveWith({
      count: 2,
      playlistId: 99,
      trackIds: null,
      entryIds: () => Promise.resolve([900, 901])
    })

    expect(scene.model.dragOver(2, 'after')).toBe(false)
    expect(scene.model.dropIndicator(2)).toBeNull()
    await scene.model.drop()

    expect(scene.calls).toEqual([])
  })

  it('refuses any drop when no playlist is being viewed', () => {
    const scene = harness({ playlistId: null })
    scene.arriveWith(libraryDrag([1, 2]))

    expect(scene.model.dragOver(0, 'before')).toBe(false)
  })
})

describe('removing', () => {
  it('removes the selection in playlist order', async () => {
    const scene = harness({ selected: [6, 1] })

    await scene.model.remove()

    expect(scene.removeEntries).toHaveBeenCalledWith([101, 106])
  })

  it('removes only the row acted on when it is outside the selection', async () => {
    const scene = harness({ selected: [1, 2] })

    await scene.model.remove(5)

    // Entry 105 and entry 100 hold the same track; only the one pointed at goes.
    expect(scene.removeEntries).toHaveBeenCalledWith([105])
  })

  /**
   * §5 rule 4 stops playback for exactly one event — deleting the playing
   * *playlist* — and removing an entry is not it. The model is the proof: there
   * is no dependency here through which a removal could reach the transport, so
   * the call log for removing the row that is currently audible is one call
   * long, whichever row that is.
   */
  it('removing the playing entry is a removal and nothing else (§5 rule 4)', async () => {
    const scene = harness()

    await scene.model.remove(3)

    expect(scene.calls).toEqual(['removeEntries'])
    expect(scene.removeEntries).toHaveBeenCalledWith([103])
  })

  it('does nothing when there is no selection and no row was named', async () => {
    const scene = harness()

    await scene.model.remove()

    expect(scene.calls).toEqual([])
  })
})

/**
 * `interface.confirmEntryRemoval`.
 *
 * The rows are resolved before the prompt goes up, which is the part worth
 * pinning: `resolveSelection` is a round trip and the pane can reload under it,
 * so a dialog phrased from `selectionCount` would be able to say one number and
 * remove another.
 */
describe('confirming a removal', () => {
  it('parks the removal rather than performing it', async () => {
    const scene = harness({ selected: [6, 1], confirmRemoval: true })

    await scene.model.remove()

    expect(scene.calls).toEqual([])
    expect(scene.model.removalPrompt.value?.entryIds).toEqual([101, 106])
    expect(scene.model.removalPrompt.value?.title).toContain('2 entries')
  })

  it('removes exactly what the prompt named', async () => {
    const scene = harness({ selected: [6, 1], confirmRemoval: true })

    await scene.model.remove()
    await scene.model.confirmRemoval()

    expect(scene.removeEntries).toHaveBeenCalledWith([101, 106])
    expect(scene.model.removalPrompt.value).toBeNull()
  })

  it('keeps everything when the prompt is dismissed', async () => {
    const scene = harness({ selected: [6, 1], confirmRemoval: true })

    await scene.model.remove()
    scene.model.cancelRemoval()

    expect(scene.calls).toEqual([])
    expect(scene.model.removalPrompt.value).toBeNull()

    // And a dismissed prompt leaves nothing behind for a later confirm to fire.
    await scene.model.confirmRemoval()
    expect(scene.calls).toEqual([])
  })

  it('asks about the row under the pointer, not the selection it is outside of', async () => {
    const scene = harness({ selected: [1, 2], confirmRemoval: true })

    await scene.model.remove(5)

    expect(scene.model.removalPrompt.value?.entryIds).toEqual([105])
    expect(scene.model.removalPrompt.value?.title).toBe('Remove this entry?')
  })

  /**
   * The album-header menu removes a whole run and knows its entry ids already,
   * so it does not go through `remove`. It went straight to the command for a
   * while, which made the toggle gate one of the two removal paths — the exact
   * half-working toggle the card says is worse than none.
   */
  it('gates the album-header removal too', async () => {
    const scene = harness({ confirmRemoval: true })

    await scene.model.removeEntries([102, 103, 104])

    expect(scene.calls).toEqual([])
    expect(scene.model.removalPrompt.value?.entryIds).toEqual([102, 103, 104])

    await scene.model.confirmRemoval()
    expect(scene.removeEntries).toHaveBeenCalledWith([102, 103, 104])
  })

  it('removes a run outright when the toggle is off', async () => {
    const scene = harness({ confirmRemoval: false })

    await scene.model.removeEntries([102, 103])

    expect(scene.removeEntries).toHaveBeenCalledWith([102, 103])
    expect(scene.model.removalPrompt.value).toBeNull()
  })

  it('has nothing to ask about when there is nothing to remove', async () => {
    const scene = harness({ confirmRemoval: true })

    await scene.model.remove()

    expect(scene.model.removalPrompt.value).toBeNull()
    expect(scene.calls).toEqual([])
  })
})
