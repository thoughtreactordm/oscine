import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { PLAY_HISTORY_CAP, type PlayEntry } from '@shared/history'
import type { Track } from '@shared/library'
import { history } from '@renderer/ipc'

/**
 * The play-history trail, held in the renderer and appended to as it happens.
 *
 * A store rather than state inside the deck pane, because the trail is recorded
 * whether or not the deck is open — that is the difference between a history
 * and a log of what you were looking at. The pane is a view onto this.
 *
 * No push event from main. Every row main writes is one this renderer asked it
 * to write, so the trail is loaded once and kept in step by prepending each
 * recorded entry as its call resolves. A second window would need the broadcast;
 * there is one window, and inventing the channel now would be inventing the
 * reconciliation too.
 *
 * `shallowRef` over an immutable array, following `upNextQueue`: entries never
 * mutate, and deep-proxying every `Track` in five hundred of them to discover
 * that is work for nothing.
 */
export const usePlayHistoryStore = defineStore('playHistory', () => {
  const entries = shallowRef<readonly PlayEntry[]>([])
  const loaded = shallowRef(false)
  const loading = shallowRef(false)

  /**
   * Reads the trail once per app run.
   *
   * Called by the pane on mount rather than eagerly at store creation: the deck
   * is closed on first launch as often as not, and five hundred display rows is
   * not a query to run for a surface nobody has opened.
   */
  async function load(): Promise<void> {
    if (loaded.value || loading.value) return
    loading.value = true
    try {
      const rows = await history.list(PLAY_HISTORY_CAP)
      // Prepends that landed while this was in flight are already newer than
      // anything main returned, so they go back on top rather than being
      // dropped — a track that started playing during the load must not vanish
      // from the trail until the next restart.
      const known = new Set(rows.map((row) => row.id))
      entries.value = [...entries.value.filter((row) => !known.has(row.id)), ...rows]
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /**
   * Records one play and puts it at the head of the trail.
   *
   * Never rejects. This is called from the audio path's `onPlayStarted` sink,
   * and a trail that could throw into a track change would be a history feature
   * with the power to interrupt playback. A failed write costs one row.
   */
  async function record(track: Track): Promise<void> {
    try {
      const entry = await history.record(track.id)
      // `null` means the track left the library between starting and being
      // recorded. Nothing to show; the play still happened and is still audible.
      if (entry === null) return
      entries.value = [entry, ...entries.value].slice(0, PLAY_HISTORY_CAP)
    } catch {
      // Deliberately silent. See above.
    }
  }

  async function clear(): Promise<void> {
    await history.clear()
    entries.value = []
  }

  return { entries, loaded, loading, load, record, clear }
})
