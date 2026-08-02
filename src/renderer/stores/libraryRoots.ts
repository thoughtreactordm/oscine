import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { FermataError, library } from '@renderer/ipc'
import type { LibraryRoot, ScanProgress } from '@shared/library'

/** What the removal dialog shows. Built in the store; see `removePrompt`. */
export interface RemovePrompt {
  rootId: number
  path: string
  title: string
  message: string
}

/**
 * The library's roots, and the scan that fills them.
 *
 * This used to live inside `Sources`, which was fine while the sidebar was the
 * only thing that could ask for a folder. It is not any more: the title bar is
 * frame chrome now and outlives every tab, so "Add music folder…" has to reach
 * something that is not a routed panel. A store is that something.
 *
 * `version` is the one message this sends downstream — a counter bumped when a
 * scan finishes and the rows behind every list have changed. Watchers reload
 * themselves; nothing here knows what a facet or a track window is.
 */
export const useLibraryRootsStore = defineStore('libraryRoots', () => {
  const roots = ref<LibraryRoot[]>([])
  const adding = ref(false)
  /** The root currently being removed, or `null`. See `removeFolder`. */
  const removing = ref<number | null>(null)
  /** The root the operator has asked to remove but not yet confirmed. */
  const pendingRemoveId = ref<number | null>(null)
  const scan = ref<ScanProgress | null>(null)
  const notice = ref<string | null>(null)
  const version = ref(0)

  let stopScan: (() => void) | null = null
  let stopNotice: (() => void) | null = null

  async function refresh(): Promise<void> {
    try {
      roots.value = await library.listRoots()
    } catch {
      notice.value = 'Could not read library folders.'
    }
  }

  async function addFolder(): Promise<void> {
    adding.value = true
    notice.value = null
    try {
      const root = await library.addRoot()
      if (root) await refresh()
    } catch (cause) {
      notice.value =
        cause instanceof FermataError ? cause.message : 'That folder could not be added.'
    } finally {
      adding.value = false
    }
  }

  /**
   * Rescans one folder, or every folder.
   *
   * `scanRoot` has existed since W2 and nothing in the UI ever called it, which
   * is why genre — and any other column a migration adds — had no way of
   * reaching a library that was already indexed. This is that gap closed.
   *
   * The summary is read rather than discarded, and that is not bookkeeping.
   * An unreachable root — an unplugged drive, an unmounted share — does not
   * reject: `scanRoot` resolves with `filesSeen: 0` and counts the root itself
   * as skipped, deliberately, because a scan that deleted a library every time
   * a NAS was asleep would be far worse than one that does nothing. But "does
   * nothing" is the correct behaviour reported as silence, and an operator who
   * has just clicked Rescan is owed the difference between "done" and "I could
   * not read that folder".
   *
   * Rescans are sequential across folders rather than concurrent. Main
   * de-duplicates per root but not across them, and three roots parsing tags at
   * once on a spinning disk is slower than doing them in turn.
   */
  async function rescan(rootId: number): Promise<void> {
    notice.value = null
    const path = roots.value.find((root) => root.id === rootId)?.path ?? 'That folder'
    try {
      const summary = await library.scanRoot(rootId)
      if (summary.filesSeen > 0) return
      // Zero files seen, and something was skipped: the walk could not read the
      // root. Zero and nothing skipped is a folder that genuinely holds no
      // audio, which is a different sentence and not an error.
      notice.value =
        summary.filesSkipped > 0
          ? `Could not read ${path}. It may be disconnected — nothing was changed.`
          : `No audio files found in ${path}.`
    } catch (cause) {
      notice.value =
        cause instanceof FermataError ? cause.message : 'That folder could not be rescanned.'
    }
  }

  async function rescanAll(): Promise<void> {
    for (const root of [...roots.value]) await rescan(root.id)
  }

  /**
   * Forgets a folder. The files stay on disk; nothing here can delete one.
   *
   * `removing` is the root id rather than a boolean, so the row being removed
   * can show it while the others stay live — and so a second click on the same
   * row is ignored without freezing the whole list.
   */
  async function removeFolder(rootId: number): Promise<void> {
    if (removing.value !== null) return
    removing.value = rootId
    notice.value = null
    try {
      roots.value = await library.removeRoot(rootId)
      // Every list downstream is showing tracks that have just gone. This is
      // the same signal a finished scan sends, and for the same reason.
      version.value += 1
    } catch (cause) {
      notice.value =
        cause instanceof FermataError ? cause.message : 'That folder could not be removed.'
    } finally {
      removing.value = null
    }
  }

  /**
   * The pending removal, and the sentence the operator is asked to agree to.
   *
   * In the store rather than in either component because both of them can start
   * a removal and only one of them is always mounted: the title-bar menu works
   * from any tab, and `Sources` is unmounted the moment the operator looks at
   * Curate. So the *state* lives here and the dialog is rendered once, by the
   * frame chrome. Two dialogs would also be two wordings to keep in step, which
   * for a destructive confirmation is the wording that matters most.
   */
  const removePrompt = computed<RemovePrompt | null>(() => {
    if (pendingRemoveId.value === null) return null
    const target = roots.value.find((root) => root.id === pendingRemoveId.value)
    if (!target) return null

    const tracks =
      target.trackCount === 1 ? '1 track' : `${target.trackCount.toLocaleString()} tracks`

    return {
      rootId: target.id,
      path: target.path,
      title: 'Remove this folder from your library?',
      // The reassurance last, because it is the thing the operator is actually
      // worried about and the thing they will remember reading.
      message:
        `${target.path} — its ${tracks} leave the library, along with their play history ` +
        `and any playlist entries pointing at them. Nothing is deleted from disk.`
    }
  })

  function requestRemove(rootId: number): void {
    pendingRemoveId.value = rootId
  }

  function cancelRemove(): void {
    pendingRemoveId.value = null
  }

  async function confirmRemove(): Promise<void> {
    const rootId = pendingRemoveId.value
    pendingRemoveId.value = null
    if (rootId !== null) await removeFolder(rootId)
  }

  /**
   * Started by the shell, not by whoever reads the store first.
   *
   * The subscriptions have to survive tab changes — a scan started from the
   * library tab still has to finish while the user is looking at Curate — so
   * their lifetime is the frame's, and the frame says when.
   */
  function start(): void {
    if (stopScan) return
    stopScan = library.onScanProgress((progress) => {
      scan.value = progress.done ? null : progress
      if (progress.done) {
        void refresh()
        version.value += 1
      }
    })
    stopNotice = library.onNotice((finding) => {
      notice.value = finding.message
      void refresh()
    })
    void refresh()
  }

  function stop(): void {
    stopScan?.()
    stopNotice?.()
    stopScan = null
    stopNotice = null
  }

  return {
    roots,
    adding,
    removing,
    pendingRemoveId,
    removePrompt,
    scan,
    notice,
    version,
    refresh,
    addFolder,
    rescan,
    rescanAll,
    removeFolder,
    requestRemove,
    confirmRemove,
    cancelRemove,
    start,
    stop
  }
})
