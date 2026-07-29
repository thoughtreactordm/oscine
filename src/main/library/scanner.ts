import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { ScanProgress, ScanSummary } from '@shared/library'
import { toRelPath } from '../db/paths'
import type { MetadataReader, TrackTags } from './metadata'
import type { LibraryStore, RootRow, ScannedTrack } from './store'
import { hasSupportedExtension, walkAudioFiles, walkAudioFilesFrom, type AudioFile } from './walk'

/**
 * The scan: a folder on disk becomes rows in the database.
 *
 * Runs on the main process rather than in a worker. The card allows either, and
 * a worker would need its own SQLite connection and a second copy of the schema
 * knowledge to write through it — real complexity, bought to solve a problem
 * this shape does not have. Parsing is I/O-bound and already yields; the only
 * genuinely blocking step is better-sqlite3, which is synchronous. So the rule
 * that keeps the window responsive is simply that no uninterrupted span of main
 * is longer than one batch write, and there is an explicit yield between them.
 */

/**
 * Files per write transaction.
 *
 * Large enough that per-transaction overhead disappears against 100k files,
 * small enough that one batch is a few milliseconds of blocked main — an IPC
 * call queued behind it waits imperceptibly.
 */
const BATCH_SIZE = 128

/**
 * Concurrent `parseFile` calls.
 *
 * Tags live in the first and last few KB of a file, so this is a seek-bound
 * workload. Some parallelism hides the latency; too much turns a mechanical
 * disk into a queue of competing seeks and scanning gets slower, not faster.
 */
const PARSE_CONCURRENCY = 8

/** Progress cadence. Faster than this is invisible and just wakes the renderer. */
const PROGRESS_INTERVAL_MS = 120

export interface ScanDeps {
  readMetadata: MetadataReader
  onProgress?: (progress: ScanProgress) => void
  /** Album ids whose candidate tracks changed, for bounded artwork reconciliation. */
  onAlbumsChanged?: (albumIds: ReadonlySet<number>) => void
  /**
   * Skip metadata parsing when the stored mtime/size pair still matches.
   *
   * Startup reconciliation enables this. An explicit user rescan remains a
   * force-reparse operation, which is useful when tags changed on a filesystem
   * whose timestamp resolution did not.
   */
  incremental?: boolean
  /** Injectable so tests can drive the progress throttle deterministically. */
  now?: () => number
}

/**
 * Whether a parse result describes an actual audio stream.
 *
 * `music-metadata` is tolerant by design: handed a renamed text file, or a
 * truncated download whose magic bytes are intact, it resolves with every field
 * empty instead of throwing — proven in `tests/main/library/metadata.test.ts`.
 * A `try`/`catch` around the parser therefore only catches I/O failures, and
 * without this check those files would be indexed as tracks that can never
 * play. Duration or codec is a low bar, and anything real clears it.
 */
function describesAudio(tags: TrackTags): boolean {
  return tags.durationMs !== null || tags.codec !== null
}

/**
 * Runs `fn` over `items`, at most `limit` at a time, preserving input order.
 *
 * `fn` is expected never to reject — the caller turns a parse failure into a
 * value, because one unreadable file must not reject the whole batch.
 */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })

  await Promise.all(workers)
  return results
}

/**
 * Indexes every supported file below `root.path`.
 *
 * Resolves with a summary; never rejects for a file-level problem. A file that
 * cannot be read or parsed is counted in `filesSkipped` and logged — the card is
 * explicit that one corrupt file must not cost the whole scan. A database write
 * failure is a different matter and does propagate: at that point the library is
 * not being updated at all, and reporting success would be a lie.
 */
export async function scanRoot(
  store: LibraryStore,
  root: Pick<RootRow, 'id' | 'path'>,
  deps: ScanDeps
): Promise<ScanSummary> {
  const now = deps.now ?? Date.now
  const startedAtMs = now()

  let filesSeen = 0
  let tracksIndexed = 0
  let filesSkipped = 0
  let currentFile: string | null = null
  let lastEmitAt = 0
  const stored = new Map(store.listTrackFiles(root.id).map((file) => [file.relPath, file]))
  const seen = new Set<string>()
  const protectedPrefixes = new Set<string>()

  const report = (done: boolean, force = false): void => {
    if (!deps.onProgress) return
    const at = now()
    // `done` always forces: the final event is what tells the UI to stop
    // showing a scan in progress, and dropping it strands the indicator.
    if (!done && !force && at - lastEmitAt < PROGRESS_INTERVAL_MS) return
    lastEmitAt = at
    deps.onProgress({
      rootId: root.id,
      filesSeen,
      tracksIndexed,
      currentFile: done ? null : currentFile,
      done
    })
  }

  const noteSkipped = (context: string, error: unknown): void => {
    filesSkipped++
    console.warn(`[scan] skipped ${context}: ${describe(error)}`)
  }

  const noteWalkError = (context: string, error: unknown): void => {
    noteSkipped(context, error)
    // A failed directory traversal is not evidence that all of its stored
    // tracks vanished. Protect the affected path (or the whole root) from the
    // deletion pass and let a later startup/event reconcile it.
    const relPath = toRelPath(root.path, context)
    protectedPrefixes.add(relPath ?? '')
  }

  let batch: AudioFile[] = []

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const pending = batch
    batch = []

    const parsed = await mapPool(pending, PARSE_CONCURRENCY, async (file) => {
      currentFile = basename(file.absPath)
      report(false)
      try {
        const tags = await deps.readMetadata(file.absPath)
        if (!describesAudio(tags)) {
          noteSkipped(file.relPath, new Error('no audio stream found'))
          return null
        }
        return { file, tags } satisfies ScannedTrack
      } catch (error) {
        // The card's requirement, and the reason this returns rather than
        // throws: a file locked by another application, a permission change, a
        // disk that went away mid-scan. All are ordinary in a real library.
        noteSkipped(file.relPath, error)
        return null
      }
    })

    const indexed = parsed.filter((entry): entry is ScannedTrack => entry !== null)
    const changedAlbums = store.writeTracks(root.id, indexed)
    deps.onAlbumsChanged?.(changedAlbums)
    tracksIndexed += indexed.length

    report(false)

    // The yield that keeps the window responsive. Everything above this line
    // ran without giving the event loop a turn, so IPC replies and window
    // events have been queued behind it since the last batch.
    await yieldToEventLoop()
  }

  try {
    // An immediate first event, so the UI can show that something started
    // before the first batch has finished parsing.
    report(false, true)

    for await (const file of walkAudioFiles(root.path, noteWalkError)) {
      filesSeen++
      seen.add(file.relPath)
      const previous = stored.get(file.relPath)
      if (
        deps.incremental &&
        previous &&
        previous.mtime === file.mtime &&
        previous.size === file.size
      ) {
        continue
      }
      batch.push(file)
      if (batch.length >= BATCH_SIZE) await flush()
    }
    await flush()

    const vanished = [...stored.keys()].filter(
      (relPath) =>
        !seen.has(relPath) &&
        ![...protectedPrefixes].some(
          (prefix) => prefix === '' || relPath === prefix || relPath.startsWith(`${prefix}/`)
        )
    )
    const changedAlbums = store.deleteTracks(root.id, vanished)
    deps.onAlbumsChanged?.(changedAlbums)

    const finishedAtMs = now()
    store.markScanned(root.id, finishedAtMs)

    return {
      rootId: root.id,
      filesSeen,
      tracksIndexed,
      filesSkipped,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString()
    }
  } finally {
    // In `finally` so a failed scan still clears the UI's progress indicator.
    // Without it, a scan that throws leaves a spinner running forever.
    report(true)
  }
}

/**
 * Reconciles only paths named by a coalesced watcher burst.
 *
 * A path may be a file, a newly-created directory, or a vanished former file
 * or directory. Directory scopes include their descendants; overlapping
 * scopes are collapsed so a rename storm never parses the same file twice.
 */
export async function reconcilePaths(
  store: LibraryStore,
  root: Pick<RootRow, 'id' | 'path'>,
  absPaths: readonly string[],
  deps: ScanDeps
): Promise<ScanSummary> {
  const now = deps.now ?? Date.now
  const startedAtMs = now()
  let tracksIndexed = 0
  let filesSkipped = 0

  const scopes = collapseScopes(
    absPaths
      .map((absPath) => ({
        absPath,
        relPath: absPath === root.path ? '' : toRelPath(root.path, absPath)
      }))
      .filter((scope): scope is { absPath: string; relPath: string } => scope.relPath !== null)
  )
  const stored = store.listTrackFiles(root.id)
  const affected = stored.filter((file) =>
    scopes.some((scope) => inScope(file.relPath, scope.relPath))
  )
  const found = new Map<string, AudioFile>()
  const forceParse = new Set<string>()
  const protectedPrefixes = new Set<string>()

  const noteError = (context: string, error: unknown): void => {
    filesSkipped++
    const relPath = context === root.path ? '' : toRelPath(root.path, context)
    if (relPath !== null) protectedPrefixes.add(relPath)
    console.warn(`[watch] skipped ${context}: ${describe(error)}`)
  }

  for (const scope of scopes) {
    try {
      const info = await stat(scope.absPath)
      if (info.isDirectory()) {
        for await (const file of walkAudioFilesFrom(root.path, scope.absPath, noteError)) {
          found.set(file.relPath, file)
        }
      } else if (
        info.isFile() &&
        !basename(scope.absPath).startsWith('.') &&
        hasSupportedExtension(scope.absPath)
      ) {
        forceParse.add(scope.relPath)
        found.set(scope.relPath, {
          absPath: scope.absPath,
          relPath: scope.relPath,
          mtime: Math.floor(info.mtimeMs),
          size: info.size
        })
      }
    } catch (error) {
      // ENOENT is the normal delete/rename half of a watcher burst. Any other
      // failure is recoverable and protects the old row until a later event.
      if (!hasErrorCode(error, 'ENOENT')) noteError(scope.absPath, error)
    }
  }

  const filesSeen = found.size
  const previous = new Map(stored.map((file) => [file.relPath, file]))
  const changed = [...found.values()].filter((file) => {
    const old = previous.get(file.relPath)
    return (
      forceParse.has(file.relPath) || !old || old.mtime !== file.mtime || old.size !== file.size
    )
  })

  for (let offset = 0; offset < changed.length; offset += BATCH_SIZE) {
    const pending = changed.slice(offset, offset + BATCH_SIZE)
    const parsed = await mapPool(pending, PARSE_CONCURRENCY, async (file) => {
      try {
        const tags = await deps.readMetadata(file.absPath)
        if (!describesAudio(tags)) {
          filesSkipped++
          console.warn(`[watch] skipped ${file.relPath}: no audio stream found`)
          return null
        }
        return { file, tags } satisfies ScannedTrack
      } catch (error) {
        filesSkipped++
        console.warn(`[watch] skipped ${file.relPath}: ${describe(error)}`)
        return null
      }
    })
    const indexed = parsed.filter((entry): entry is ScannedTrack => entry !== null)
    const changedAlbums = store.writeTracks(root.id, indexed)
    deps.onAlbumsChanged?.(changedAlbums)
    tracksIndexed += indexed.length
    await yieldToEventLoop()
  }

  const vanished = affected
    .filter((file) => !found.has(file.relPath))
    .filter(
      (file) =>
        ![...protectedPrefixes].some(
          (prefix) => file.relPath === prefix || file.relPath.startsWith(`${prefix}/`)
        )
    )
    .map((file) => file.relPath)
  const changedAlbums = store.deleteTracks(root.id, vanished)
  deps.onAlbumsChanged?.(changedAlbums)

  const finishedAtMs = now()
  const progress: ScanProgress = {
    rootId: root.id,
    filesSeen,
    tracksIndexed,
    currentFile: null,
    done: true
  }
  deps.onProgress?.(progress)
  return {
    rootId: root.id,
    filesSeen,
    tracksIndexed,
    filesSkipped,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString()
  }
}

function collapseScopes(
  scopes: Array<{ absPath: string; relPath: string }>
): Array<{ absPath: string; relPath: string }> {
  return scopes
    .sort((a, b) => a.relPath.length - b.relPath.length)
    .filter(
      (scope, index, all) =>
        !all.slice(0, index).some((parent) => inScope(scope.relPath, parent.relPath))
    )
}

function inScope(relPath: string, scope: string): boolean {
  return scope === '' || relPath === scope || relPath.startsWith(`${scope}/`)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
