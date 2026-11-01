import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { LibraryChanged } from '@shared/libraryChanges'
import { library } from '@renderer/ipc'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { useTagsStore } from '@renderer/stores/tags'
import {
  isEmptyRefetchPlan,
  namesId,
  planLibraryRefetch,
  type LibraryRefetchPlan
} from '@renderer/stores/libraryChangePlan'

/**
 * Follows `library.changed` — **D36.9** — and re-reads exactly what it names.
 *
 * - playlists → the rail re-reads; an entry change also reloads the open pane,
 *   through the same `entriesEdited` signal a local edit publishes.
 * - overrides → the library version bumps, as an editor save does, so the
 *   track list, facets and browse reload.
 * - tags → the cached track tags named are re-read, and the vocabulary with
 *   them while something is holding it.
 * - tagOverrides → not materialised into any row; published on {@link last}
 *   for a pane that shows them.
 *
 * What to do is decided in `libraryChangePlan.ts`, which is pure and tested;
 * this store only carries it out. Owned by the frame, like `libraryRoots`.
 */
export const useLibraryChangesStore = defineStore('libraryChanges', () => {
  const roots = useLibraryRootsStore()
  const playlists = usePlaylistsStore()
  const tags = useTagsStore()

  /** The last payload acted on, with its plan, for panes that want to look. */
  const last = shallowRef<{ event: LibraryChanged; plan: LibraryRefetchPlan; seq: number } | null>(
    null
  )

  let stop: (() => void) | null = null

  function apply(event: LibraryChanged): void {
    const plan = planLibraryRefetch(event)
    if (isEmptyRefetchPlan(plan)) return

    if (plan.playlists) void playlists.refreshAfterChange()
    const viewed = playlists.viewedPlaylistId
    if (viewed !== null && namesId(plan.playlistEntries, viewed)) {
      playlists.noteEntriesChanged(viewed)
    }
    if (plan.trackRows) roots.markChanged()
    if (plan.tagVocabulary) void tags.refetchTracks(plan.tagTracks)

    last.value = { event, plan, seq: (last.value?.seq ?? 0) + 1 }
  }

  function start(): void {
    if (stop) return
    stop = library.onChanged(apply)
  }

  function dispose(): void {
    stop?.()
    stop = null
  }

  return { last, start, stop: dispose }
})
