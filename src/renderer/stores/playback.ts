import { defineStore } from 'pinia'
import { createAudioEngineFactory } from '@renderer/audio'
import { library } from '@renderer/ipc'
import { createPlaybackController } from '@renderer/playback/controller'

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
  // prefetched decoded buffers in the same proven-freed ledger.
  const createEngine = createAudioEngineFactory()
  return createPlaybackController({
    createEngine,
    fetchPage: (query) => library.listTracks(query)
  })
})
