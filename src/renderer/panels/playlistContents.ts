import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'
import type { PlaylistInsertion } from '@shared/playlists'
import { lazily, type RowDragPayload } from './trackDrag'

/**
 * The contents pane's rules, with no DOM underneath them.
 *
 * `playlistTabs` is the sibling of this module and it exists for the same
 * reason: what makes a contents pane wrong is arithmetic and identity, not
 * markup. A drop that lands one row off, a reorder that moves both copies of a
 * duplicate, a remove that stops playback when nothing said it should — none of
 * those need a browser to reproduce, and none would be caught by reading the
 * component.
 *
 * ## Two things this module is careful about
 *
 * **Entry ids, everywhere.** D12 makes the same track legal twice in one
 * playlist. Every id that crosses this module is a `playlist_entries.id`; the
 * word `trackId` appears only on the inbound path, where rows arriving from the
 * library genuinely are tracks and not yet entries.
 *
 * **It cannot reach playback.** There is no dependency here through which a
 * removal could stop, pause or re-anchor anything, and that is the whole of this
 * card's §5 obligation. §5 stops playback for exactly one event — deleting the
 * *playing playlist* (rule 4), which is `usePlaylistsStore().remove` and not
 * this — so removing entries, including the one being heard, leaves playback
 * alone. Structural rather than disciplinary, the way the viewed/playing split
 * is: there is no wire to pull.
 */

/** Which edge of a row a drop lands against. */
export type DropSide = 'before' | 'after'

/** Where a drop landed. `null` is the empty area past the last row. */
export interface DropTarget {
  readonly index: number | null
  readonly side: DropSide
}

export interface PlaylistContentsCommands {
  /** One call for the whole batch, however many rows were dropped. */
  addTracks: (trackIds: readonly number[], insertion: PlaylistInsertion) => Promise<void>
  moveEntries: (entryIds: readonly number[], insertion: PlaylistInsertion) => Promise<void>
  removeEntries: (entryIds: readonly number[]) => Promise<void>
}

export interface PlaylistContentsDeps {
  playlistId: () => number | null
  /** The entry id at a loaded position, or `undefined` when its page is not held. */
  entryIdAt: (index: number) => number | undefined
  isSelectedAt: (index: number) => boolean
  selectionCount: () => number
  /** The selection as entry ids in playlist order. */
  resolveSelection: () => Promise<readonly number[]>
  /** What is being dragged. Injected so the model runs without a `DataTransfer`. */
  activeDrag: () => RowDragPayload | null
  /** Announces the rows this pane has picked up. */
  beginDrag: (payload: RowDragPayload) => void
  endDrag: () => void
  /**
   * `interface.confirmEntryRemoval`, as a getter for the reason
   * `PlaylistRailDeps.confirmDelete` is one: this module is driven without
   * Pinia, and the default still lives only in the registry.
   */
  confirmRemoval: MaybeRefOrGetter<boolean>
  commands: PlaylistContentsCommands
}

/** A removal the operator has to agree to before it happens. */
export interface RemovalPrompt {
  entryIds: readonly number[]
  title: string
  message: string
}

/**
 * Turns a drop target into the insertion the IPC contract speaks.
 *
 * Expressed against a neighbour rather than an index because that is what
 * `PlaylistInsertion` is, and for the reason it gives: an index only means
 * something to a caller holding the whole list, and this pane holds a window.
 *
 * A row whose page is not loaded cannot be an anchor — the pointer is over a
 * skeleton — so the drop falls to the end rather than guessing at an id.
 */
export function insertionFor(
  target: DropTarget,
  entryIdAt: (index: number) => number | undefined
): PlaylistInsertion {
  if (target.index === null) return { at: 'end' }
  const entryId = entryIdAt(target.index)
  if (entryId === undefined) return { at: 'end' }
  return { at: target.side, entryId }
}

export function createPlaylistContents(deps: PlaylistContentsDeps) {
  const target = ref<DropTarget | null>(null)
  const pendingRemoval = ref<readonly number[] | null>(null)

  /**
   * What the prompt says, built from the ids rather than from the selection.
   *
   * The selection is resolved *before* the prompt goes up — `resolveSelection`
   * is a round trip through main and the only honest reading of a selection
   * over a windowed list — so the count in the dialog is the count that will be
   * removed, even if the pane reloads underneath it. A prompt phrased from
   * `selectionCount` would have been a second, racing answer.
   */
  const removalPrompt = computed<RemovalPrompt | null>(() => {
    const entryIds = pendingRemoval.value
    if (entryIds === null || entryIds.length === 0) return null
    const many = entryIds.length > 1
    return {
      entryIds,
      title: many ? `Remove ${entryIds.length.toLocaleString()} entries?` : 'Remove this entry?',
      message: many
        ? 'They come out of this playlist only. The files stay on disk, and playback is not interrupted.'
        : 'It comes out of this playlist only. The file stays on disk, and playback is not interrupted.'
    }
  })

  /**
   * Whether the drag in flight can land here at all.
   *
   * A library drag brings track ids and becomes an add. A drag from *this* pane
   * brings entry ids and becomes a reorder. A drag from another playlist's pane
   * is neither: copying it would need every dragged entry resolved back to a
   * track id, and the contract has no verb that does it in one call. Refused
   * visibly — no indicator, no drop — rather than silently doing nothing, and
   * left to whenever a card actually asks for playlist-to-playlist dragging.
   */
  function accepts(drag: RowDragPayload | null): boolean {
    const id = deps.playlistId()
    if (drag === null || id === null) return false
    if (drag.playlistId === null) return drag.trackIds !== null
    return drag.playlistId === id && drag.entryIds !== null
  }

  /**
   * The rows a drag starting at `index` is carrying.
   *
   * A drag begun on a selected row takes the whole selection; begun anywhere
   * else it takes that row alone and leaves the selection untouched. The second
   * case cannot go through the selection at all: `dragstart` is synchronous and
   * selecting a row is a round trip, so a drag that first had to select would
   * carry an empty payload.
   */
  function draggedEntryIds(index: number): (() => Promise<readonly number[]>) | null {
    if (deps.isSelectedAt(index)) return lazily(() => Promise.resolve(deps.resolveSelection()))
    const entryId = deps.entryIdAt(index)
    if (entryId === undefined) return null
    return () => Promise.resolve([entryId])
  }

  /** The rows a remove gesture is about: the selection, or the row it started on. */
  async function resolveRemoval(index?: number): Promise<readonly number[]> {
    if (index !== undefined && !deps.isSelectedAt(index)) {
      const entryId = deps.entryIdAt(index)
      return entryId === undefined ? [] : [entryId]
    }
    return deps.resolveSelection()
  }

  /**
   * The one place a removal happens, whichever menu asked for it.
   *
   * The row menu and the album-header menu arrive at their ids differently — one
   * from the selection, one from a run's range — and for a while the header menu
   * called `removeEntries` itself, which meant the confirmation gated one of the
   * two. A toggle that stops half the removals is worse than no toggle, so both
   * come through here and the gate is read in exactly one place.
   */
  async function performRemoval(entryIds: readonly number[]): Promise<void> {
    if (entryIds.length === 0) return
    if (toValue(deps.confirmRemoval)) {
      pendingRemoval.value = entryIds
      return
    }
    await deps.commands.removeEntries(entryIds)
  }

  return {
    /** The row a drop marker belongs on, and which edge. */
    dropIndicator: (index: number): DropSide | null =>
      target.value !== null && target.value.index === index ? target.value.side : null,

    /** True while a drop would land past the last row. */
    droppingAtEnd: computed(() => target.value !== null && target.value.index === null),

    dragCount: computed(() => deps.activeDrag()?.count ?? 0),

    /** Picks rows up. Returns false when there is nothing at `index` to carry. */
    beginDrag(index: number): boolean {
      const entryIds = draggedEntryIds(index)
      if (entryIds === null) return false
      const count = deps.isSelectedAt(index) ? Math.max(1, deps.selectionCount()) : 1
      deps.beginDrag({
        count,
        playlistId: deps.playlistId(),
        // A reorder is expressed in entry ids; see `accepts`.
        trackIds: null,
        entryIds
      })
      return true
    },

    /** `true` claims the drag, which is the component's cue to `preventDefault`. */
    dragOver(index: number | null, side: DropSide): boolean {
      if (!accepts(deps.activeDrag())) return false
      target.value = { index, side }
      return true
    },

    /**
     * Commits the drop: one call, whether it moved four rows or added four
     * thousand. The batch is what `AddTracksToPlaylistRequest` exists for, and a
     * drop that fanned out into one request per row is the failure this pane is
     * measured against.
     */
    async drop(): Promise<void> {
      const drag = deps.activeDrag()
      const landing = target.value
      target.value = null
      if (landing === null || !accepts(drag) || drag === null) return

      const insertion = insertionFor(landing, deps.entryIdAt)
      if (drag.entryIds !== null) {
        const entryIds = await drag.entryIds()
        // A drop onto the moved selection itself is a no-op in main, which is
        // where it belongs: it is a gesture users make, not an error.
        if (entryIds.length > 0) await deps.commands.moveEntries(entryIds, insertion)
        return
      }
      if (drag.trackIds === null) return
      const trackIds = await drag.trackIds()
      if (trackIds.length > 0) await deps.commands.addTracks(trackIds, insertion)
    },

    endDrag(): void {
      target.value = null
      deps.endDrag()
    },

    /** The removal waiting on an answer, or null. */
    removalPrompt,

    /**
     * Removes the selection, or the row under the pointer when nothing is
     * selected — asking first when `interface.confirmEntryRemoval` says to.
     *
     * The setting is read after the ids are in hand, not before, so the
     * unconfirmed path and the confirmed one resolve the same rows the same way
     * and there is one place a removal can be assembled.
     */
    async remove(index?: number): Promise<void> {
      await performRemoval(await resolveRemoval(index))
    },

    /**
     * The same removal, for a caller that already knows the entry ids — the
     * album-header menu, which takes a whole run rather than a selection.
     */
    removeEntries: (entryIds: readonly number[]): Promise<void> => performRemoval(entryIds),

    async confirmRemoval(): Promise<void> {
      const entryIds = pendingRemoval.value
      pendingRemoval.value = null
      if (entryIds === null || entryIds.length === 0) return
      await deps.commands.removeEntries(entryIds)
    },

    cancelRemoval(): void {
      pendingRemoval.value = null
    }
  }
}

export type PlaylistContents = ReturnType<typeof createPlaylistContents>
