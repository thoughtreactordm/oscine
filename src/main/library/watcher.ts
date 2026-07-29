import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { toRelPath } from '../db/paths'
import { listLibraryDirectories } from './walk'

export type WatchMode = 'live' | 'startup-scan-only'

export interface WatchSubscription {
  close(): void
}

export interface DirectoryWatchAdapter {
  watch(
    directory: string,
    onEvent: (filename: string | null) => void,
    onError: (error: unknown) => void
  ): WatchSubscription
}

/** Production adapter; tests inject a deterministic in-memory implementation. */
export const nativeDirectoryWatchAdapter: DirectoryWatchAdapter = {
  watch(directory, onEvent, onError): FSWatcher {
    const watcher = watch(directory, (_eventType, filename) => {
      onEvent(filename === null ? null : filename.toString())
    })
    watcher.on('error', onError)
    return watcher
  }
}

export interface WatchFinding {
  rootId: number
  path: string
  error: unknown
}

export interface RootWatcherDeps {
  adapter?: DirectoryWatchAdapter
  debounceMs?: number
  settleMs?: number
  onPaths: (rootId: number, paths: readonly string[]) => Promise<void>
  onModeChange: (rootId: number, mode: WatchMode, error?: unknown) => void
  onFinding?: (finding: WatchFinding) => void
}

interface WatchedRoot {
  id: number
  path: string
  handles: Map<string, WatchSubscription>
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  stopped: boolean
}

/**
 * Owns exactly one directory-watch set for each root.
 *
 * Native `fs.watch({ recursive: true })` is intentionally avoided: its support
 * and semantics vary by platform. The adapter watches each directory and this
 * class supplies identical debounce, settling and degradation behavior on
 * Windows and Linux.
 */
export class RootDirectoryWatcher {
  private readonly adapter: DirectoryWatchAdapter
  private readonly debounceMs: number
  private readonly settleMs: number
  private readonly roots = new Map<number, WatchedRoot>()

  constructor(private readonly deps: RootWatcherDeps) {
    this.adapter = deps.adapter ?? nativeDirectoryWatchAdapter
    this.debounceMs = deps.debounceMs ?? 350
    this.settleMs = deps.settleMs ?? 250
  }

  async startRoot(root: { id: number; path: string }): Promise<void> {
    this.stopRoot(root.id)
    const watched: WatchedRoot = {
      id: root.id,
      path: root.path,
      handles: new Map(),
      pending: new Set(),
      timer: null,
      stopped: false
    }
    this.roots.set(root.id, watched)
    await this.refresh(watched)
    if (!watched.stopped) this.deps.onModeChange(root.id, 'live')
  }

  async refreshRoot(rootId: number): Promise<void> {
    const watched = this.roots.get(rootId)
    if (watched && !watched.stopped) await this.refresh(watched)
  }

  stopRoot(rootId: number): void {
    const watched = this.roots.get(rootId)
    if (!watched) return
    watched.stopped = true
    if (watched.timer) clearTimeout(watched.timer)
    for (const handle of watched.handles.values()) handle.close()
    watched.handles.clear()
    watched.pending.clear()
    this.roots.delete(rootId)
  }

  close(): void {
    for (const rootId of [...this.roots.keys()]) this.stopRoot(rootId)
  }

  /** Diagnostic/test seam proving handles scale with directories. */
  watchCount(rootId?: number): number {
    if (rootId !== undefined) return this.roots.get(rootId)?.handles.size ?? 0
    let count = 0
    for (const watched of this.roots.values()) count += watched.handles.size
    return count
  }

  private async refresh(watched: WatchedRoot): Promise<void> {
    const directories = await listLibraryDirectories(watched.path, (path, error) => {
      this.deps.onFinding?.({ rootId: watched.id, path, error })
    })
    if (watched.stopped) return

    const current = new Set(directories)
    for (const [directory, handle] of watched.handles) {
      if (!current.has(directory)) {
        handle.close()
        watched.handles.delete(directory)
      }
    }

    for (const directory of directories) {
      if (watched.handles.has(directory)) continue
      try {
        const handle = this.adapter.watch(
          directory,
          (filename) =>
            this.queue(watched, filename === null ? directory : resolve(directory, filename)),
          (error) => this.handleWatchError(watched, directory, error)
        )
        watched.handles.set(directory, handle)
      } catch (error) {
        this.handleWatchError(watched, directory, error)
        if (watched.stopped) return
      }
    }
  }

  private queue(watched: WatchedRoot, absPath: string): void {
    if (
      watched.stopped ||
      (resolve(watched.path) !== resolve(absPath) && toRelPath(watched.path, absPath) === null)
    ) {
      return
    }
    watched.pending.add(absPath)
    if (watched.timer) clearTimeout(watched.timer)
    watched.timer = setTimeout(() => {
      watched.timer = null
      void this.flush(watched)
    }, this.debounceMs)
  }

  private async flush(watched: WatchedRoot): Promise<void> {
    if (watched.stopped || watched.pending.size === 0) return
    const paths = [...watched.pending]
    watched.pending.clear()

    const before = await Promise.all(paths.map(snapshot))
    if (this.settleMs > 0) await delay(this.settleMs)
    const after = await Promise.all(paths.map(snapshot))
    if (watched.stopped) return

    const stable: string[] = []
    paths.forEach((path, index) => {
      // Missing paths and directories need no write-settling delay. Files are
      // only parsed after two matching size/mtime observations.
      if (
        after[index] === 'missing' ||
        after[index] === 'directory' ||
        before[index] === after[index]
      ) {
        stable.push(path)
      } else {
        this.queue(watched, path)
      }
    })

    if (stable.length === 0) return
    try {
      // Attach to newly-created subdirectories before reconciliation so files
      // written into them during that walk cannot fall into an unwatched gap.
      await this.refresh(watched)
      await this.deps.onPaths(watched.id, stable)
      await this.refresh(watched)
    } catch (error) {
      this.deps.onFinding?.({ rootId: watched.id, path: watched.path, error })
    }
  }

  private handleWatchError(watched: WatchedRoot, path: string, error: unknown): void {
    if (watched.stopped) return
    if (isEnospc(error)) {
      const rootId = watched.id
      this.stopRoot(rootId)
      this.deps.onModeChange(rootId, 'startup-scan-only', error)
      return
    }
    this.deps.onFinding?.({ rootId: watched.id, path, error })
  }
}

async function snapshot(path: string): Promise<string> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    return `${Math.floor(info.mtimeMs)}:${info.size}`
  } catch {
    return 'missing'
  }
}

function isEnospc(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOSPC'
  )
}
