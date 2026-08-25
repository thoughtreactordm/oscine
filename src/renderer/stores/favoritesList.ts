import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { OscineError, favorites as ipc } from '@renderer/ipc'
import { createFavoritesWindow } from '@renderer/panels/favoritesWindow'
import { useFavoritesStore } from '@renderer/stores/favorites'

/**
 * My Favorites, as rows — **D18**.
 *
 * `playlistEntries`' opposite number, and thin for the same reason:
 * `createFavoritesWindow` holds the paging and the selection and knows nothing
 * about Pinia or IPC, and this is the one place the real `favorites.list` is
 * bolted on.
 *
 * **It follows the heart and never writes it in secret.** Every state change in
 * the table is announced by `useFavoritesStore`, whichever surface made it, and
 * this reloads on the announcement rather than on a gesture of its own. That is
 * what makes "heart a track anywhere and it appears at the top of My Favorites"
 * one subscription instead of a wire from each of the places a heart is drawn.
 *
 * The pinned entry is permanent, so unlike the entries store there is no
 * "pointed at nothing" state to hold: this store *is* the collection, and it
 * primes itself the moment anything asks — the rail's count and the pane's first
 * page are the same read.
 */
export const useFavoritesListStore = defineStore('favoritesList', () => {
  const hearts = useFavoritesStore()

  const panel = createFavoritesWindow({
    fetchPage: (query) => ipc.list(query),
    fetchIdPage: (query) => ipc.listIds(query)
  })

  /** The one notice this collection has. Its own, because it has no strip to borrow. */
  const notice = ref<string | null>(null)

  /**
   * Re-reads on any heart, anywhere.
   *
   * A departure is `forget`-ten *before* the reload, because the rows are gone
   * and a selection still holding them would report a count the pane cannot
   * show — the same ordering `playlistEntries.removeEntries` uses and for the
   * same reason. An arrival has nothing to forget and only moves rows down.
   */
  watch(
    () => hearts.changed,
    (change) => {
      if (change === null) return
      if (!change.favorite) panel.forget([change.trackId])
      panel.reload()
    }
  )

  /**
   * Un-favorites a batch — what removing rows from the pinned entry means.
   *
   * **Not confirmed, deliberately.** `interface.confirmEntryRemoval` gates
   * removing entries from a playlist, where the row is a thing the operator
   * authored and its position is work that cannot be recovered by clicking once.
   * A favorite is a boolean, and un-hearting it from a list row or from
   * NowPlaying asks nobody anything; a dialog on the same fact said from the
   * other end would be the two gestures disagreeing about how serious it is.
   *
   * The overrides are written from the answer rather than predicted, so every
   * heart on screen for these tracks empties at once — including the ones in
   * lists this store has never heard of.
   */
  async function remove(trackIds: readonly number[]): Promise<void> {
    if (trackIds.length === 0) return
    try {
      await ipc.remove(trackIds)
      // Before the reload, and before the announcement each of these makes: the
      // rows are gone, and a selection still holding them reports a count the
      // pane cannot show.
      panel.forget(trackIds)
      for (const trackId of trackIds) hearts.noteChanged(trackId, false)
      notice.value = null
    } catch (cause) {
      notice.value =
        cause instanceof OscineError ? cause.message : 'Those tracks could not be removed.'
    }
  }

  // Primed on creation rather than on mount, because two islands reach for this
  // — the rail's pinned entry, for its count, and the pane, for its first page —
  // and neither may assume the other is on screen. One store, one first read.
  panel.reload()

  return { ...panel, notice, remove }
})
