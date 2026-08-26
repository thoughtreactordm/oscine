import { watch } from 'vue'
import { defineStore } from 'pinia'
import {
  EMPTY_QUEUE_SESSION,
  QUEUE_SESSION_KEY,
  RESTORE_QUEUE_KEY,
  type QueueSession
} from '@shared/settings'
import { createAudioEngineFactory } from '@renderer/audio'
import { favorites, library, listens, playlists } from '@renderer/ipc'
import { createBrowserMediaSessionPlatform } from '@renderer/playback/browserMediaSession'
import { createPlaybackController } from '@renderer/playback/controller'
import { createMediaSessionBinding } from '@renderer/playback/mediaSession'
import { restoredQueueSession, useSettings } from '@renderer/settings'
import { usePlayHistoryStore } from '@renderer/stores/playHistory'

/**
 * Playback state for the whole app: what is loaded, where it has reached, and
 * the order it is playing through.
 *
 * A store rather than state inside `NowPlaying` because playback outlives any
 * one panel — the transport, the track list's playing-row highlight and W5's
 * queue are all views onto the same thing, and a panel that owned it would make
 * the others depend on it being mounted.
 *
 * Thin on purpose, exactly like `trackList`. The behaviour lives in
 * `createPlaybackController`, which knows nothing about Pinia, IPC or Web
 * Audio; this is the one place the real engine and the real page fetch are
 * bolted on.
 */
export const usePlaybackStore = defineStore('playback', () => {
  // Both scheduler slots come from one factory so R1 accounts current and
  // prefetched decoded buffers in the same proven-freed ledger. The factory also
  // owns the output device, because the sink belongs to the AudioContexts it
  // built rather than to either engine — see `audio/outputDevice.ts`.
  const audio = createAudioEngineFactory()
  // Resolved once: absent means the runtime has no Media Session API, and the
  // controller simply runs unbound.
  const mediaSessionPlatform = createBrowserMediaSessionPlatform()
  // The trail's recorder. Resolved here rather than inside the sink so the
  // dependency is visible at the wiring, and one-directional: the trail store
  // knows nothing about playback.
  const playHistory = usePlayHistoryStore()

  // The unified settings surface, captured so this store can gate and persist
  // the queue snapshot as well as hand it to the controller.
  const settings = useSettings()

  /**
   * The listen writes that have not landed yet — normally none, at most one.
   *
   * Tracked rather than fired and forgotten because of the quit flush: main
   * asks the renderer to depart its in-flight listen and then closes the
   * database, and answering before the insert has crossed IPC would make the
   * handshake protect nothing. Everywhere else this set is empty by the time
   * anyone looks at it.
   */
  const inFlightWrites = new Set<Promise<unknown>>()

  const controller = createPlaybackController({
    createEngine: audio.createEngine,
    setOutputDevice: audio.setOutputDevice,
    fetchPage: (query) => library.listTracks(query),
    fetchPlaylistEntries: (query) => playlists.listEntries(query),
    // D18's collection. One verb, because `favorites.list` answers in the
    // display projection and there is only one order over it.
    fetchFavorites: (query) => favorites.list(query),
    // The session tier's two verbs (§5 amendment). Both already existed —
    // materializing the scope needed no new IPC surface, which is what made the
    // shuffle case affordable.
    fetchTrackIds: (query) => library.listTrackIds(query),
    fetchTracksByIds: (query) => library.getTracksByIds(query),
    // W7-4's trail. Every play, at the moment the transport commits to it,
    // skips included — see `shared/history.ts` for why that and not a
    // listened-threshold. Voided rather than awaited: nothing about a track
    // change may wait on a database write.
    onPlayStarted: (track) => void playHistory.record(track),
    // W10-4's listen commit. The other end of the play, and only for one that
    // crossed the threshold — see `shared/listens.ts` for why that and the
    // trail above are two records rather than one. Swallowed rather than
    // surfaced: a listen that fails to write costs one row, and an error thrown
    // out of a track change would be a statistics feature with the power to
    // interrupt playback.
    onListenDeparted: (entry) => {
      const write = listens
        .record(entry)
        .catch(() => null)
        .finally(() => inFlightWrites.delete(write))
      inFlightWrites.add(write)
    },
    // Both scopes, live. Shuffle and repeat survive a restart and the shuffle
    // sequence does not; the global crossfade is durable and reaches the
    // scheduler at the next boundary rather than at the next launch.
    settings,
    ...(mediaSessionPlatform
      ? {
          createMediaSession: ({ state, transport }) =>
            createMediaSessionBinding({ platform: mediaSessionPlatform, state, transport })
        }
      : {})
  })

  /**
   * The quit-time flush (D17). Main asks; this answers.
   *
   * Never unsubscribed, and that is the point: it is live for exactly as long
   * as the renderer is, which is the window in which a quit can happen. There
   * is nothing to clean up because there is no moment before teardown at which
   * having stopped listening would be correct.
   *
   * The answer goes out after the departure's write has landed rather than
   * after the departure itself — main closes the database on receiving it, so
   * acknowledging an insert still in flight would ack a row that never gets
   * written. A flush with nothing to commit resolves on an empty set and costs
   * one round trip, which is why main does not have to wait out its timeout in
   * the ordinary case.
   */
  listens.onFlushRequested(() => {
    controller.flushListen()
    // The quit is also the last chance to capture where the current track had
    // reached: the watcher below records the queue and position on every track
    // and order change, but not on the elapsed time, which only this catches.
    void persistQueue()
    void Promise.all([...inFlightWrites])
      .then(() => listens.flushed())
      .catch(() => {
        // Main's timeout is the backstop. There is nothing useful to do with a
        // failure here and nowhere left to show it.
      })
  })

  /**
   * Write the current queue snapshot, gated by `view.restoreQueue` (G2, W14-6).
   *
   * The gate is on the *write* as well as the read — unlike tab-restore, which
   * always records. A queue snapshot names the tracks the operator was playing,
   * and keeping that while they have opted out is the wrong default; see
   * `restoredQueueSession`. An idle transport snapshots to the empty session,
   * which is what stops a quit-while-stopped from resurrecting a queue.
   */
  const persistQueue = async (): Promise<void> => {
    if (!settings.get<boolean>(RESTORE_QUEUE_KEY)) return
    const snapshot = await controller.snapshotSession()
    void settings.set<QueueSession>(QUEUE_SESSION_KEY, snapshot)
  }

  // Restore last session's queue, paused. `restoredQueueSession` returns the
  // empty session when the gate is shut, and the controller no-ops on that, so
  // this needs no gate of its own. Fire-and-forget: it fetches the current track
  // over IPC, and nothing about constructing the store may wait on that.
  void controller.hydrateSession(restoredQueueSession(settings))

  // Persist whenever the queue's identity changes — a new track, a move through
  // the order, a shuffle toggle that re-pins it. Not on elapsed time, which
  // would write on every timeupdate; the quit flush above covers that instead.
  watch(
    [
      () => controller.nowPlaying.value,
      () => controller.orderIndex.value,
      () => controller.shuffleEnabled.value
    ],
    () => void persistQueue()
  )

  // Turning the gate off clears the stored queue immediately rather than leaving
  // last session's tracks on disk; turning it on captures the current one so it
  // is there to restore even if nothing changes before the next quit.
  watch(
    () => settings.get<boolean>(RESTORE_QUEUE_KEY),
    (on) => {
      if (on) void persistQueue()
      else void settings.set<QueueSession>(QUEUE_SESSION_KEY, { ...EMPTY_QUEUE_SESSION })
    }
  )

  return controller
})
