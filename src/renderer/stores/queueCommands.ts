import { defineStore } from 'pinia'
import { library } from '@renderer/ipc'
import { createQueueCommands } from '@renderer/playback/queueCommands'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The one place the queue verbs are bolted to the real controller and the real
 * IPC.
 *
 * A store rather than a `createQueueCommands` call in each component, so that
 * "the commands live in a module the Tunedeck up-next pane can import
 * unchanged" is true of the *wiring* as well as of the module: W7-2 reaches for
 * this store and gets the same verbs the library list, the playlist pane and the
 * overlay are already using, with no second set of dependencies to keep in step.
 *
 * Thin, like every store here — the behaviour is all in `queueCommands.ts`,
 * which knows nothing about Pinia or IPC and is tested without either.
 */
export const useQueueCommandsStore = defineStore('queueCommands', () => {
  const playback = usePlaybackStore()

  return createQueueCommands({
    fetchTracks: (trackIds) => library.getTracksByIds({ ids: [...trackIds] }),
    queue: {
      enqueue: (tracks) => playback.enqueue(tracks),
      enqueueNext: (tracks) => playback.enqueueNext(tracks),
      remove: (entryId) => playback.removeQueued(entryId),
      move: (entryId, toIndex) => playback.moveQueued(entryId, toIndex),
      clearUser: () => playback.clearUserQueue(),
      clear: () => playback.clearQueue(),
      play: (entryId) => playback.playQueued(entryId)
    }
  })
})
