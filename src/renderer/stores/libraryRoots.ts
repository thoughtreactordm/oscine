import { defineStore } from 'pinia'
import { ref } from 'vue'
import { FermataError, library } from '@renderer/ipc'
import type { LibraryRoot, ScanProgress } from '@shared/library'

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

  return { roots, adding, scan, notice, version, refresh, addFolder, start, stop }
})
