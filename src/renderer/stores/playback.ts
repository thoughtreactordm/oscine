import { defineStore } from 'pinia'
import { createAudioEngineFactory } from '@renderer/audio'
import { library, listens, playlists } from '@renderer/ipc'
import { createBrowserMediaSessionPlatform } from '@renderer/playback/browserMediaSession'
import { createPlaybackController } from '@renderer/playback/controller'
import { createMediaSessionBinding } from '@renderer/playback/mediaSession'
import { useSettings } from '@renderer/settings'
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
    settings: useSettings(),
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
    void Promise.all([...inFlightWrites])
      .then(() => listens.flushed())
      .catch(() => {
        // Main's timeout is the backstop. There is nothing useful to do with a
        // failure here and nowhere left to show it.
      })
  })

  return controller
})
