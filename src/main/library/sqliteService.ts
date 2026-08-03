import type Database from 'better-sqlite3'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { FermataError } from '@shared/errors'
import type {
  GetTracksByIdsQuery,
  LibraryNotice,
  LibraryRoot,
  LibraryWatchMode,
  ListAlbumsResult,
  ListArtistsResult,
  ListFacetIdsQuery,
  ListFacetIdsResult,
  ListFacetsQuery,
  ListTrackGroupsQuery,
  ListTrackGroupsResult,
  ListTrackIdsQuery,
  ListTrackIdsResult,
  ListTracksQuery,
  ListTracksResult,
  OrderTrackIdsQuery,
  ReplayGainJobProgress,
  ScanProgress,
  ScanSummary,
  Track,
  TrackAudioMetadata,
  TrackFormatDetail
} from '@shared/library'
import type { RelatedQuery, RelatedResult } from '@shared/related'
import { buildRelated } from './related'
import {
  readTrackFormatDetail,
  readTrackTags,
  type FormatDetailReader,
  type MetadataReader
} from './metadata'
import type { EmbeddedArtworkReader } from './metadata'
import { reconcilePaths, scanRoot } from './scanner'
import { LibraryStore, type RootConflict, type RootRow } from './store'
import { ArtworkCacheService, isArtworkSidecarPath } from './artwork'
import type { ArtworkImageProcessor } from './artworkProcessor'
import { RootDirectoryWatcher, type DirectoryWatchAdapter, type WatchMode } from './watcher'
import type { LibraryService } from './service'
import type { ReplayGainAnalyzer } from '../replaygain/analyzer'
import { ReplayGainJobService } from '../replaygain/jobService'
import { toRelPath } from '../db/paths'

/**
 * The database-backed library.
 *
 * Electron appears nowhere in this file. The two things that genuinely need it —
 * the folder picker and the channel progress travels down — arrive as functions,
 * so the whole add-root-and-scan flow can be driven from a test with a temp
 * directory and no application. `src/main/index.ts` supplies the real ones.
 */
export interface SqliteLibraryDeps {
  db: Database.Database
  /** Opens the OS folder picker. Resolves `null` when the user cancels. */
  pickFolder: () => Promise<string | null>
  /** Pushes a progress event at the renderer. */
  onProgress: (progress: ScanProgress) => void
  /** Pushes durable ReplayGain job progress at the renderer. */
  onReplayGainProgress?: (progress: ReplayGainJobProgress) => void
  /** Pushes actionable lifecycle findings at the renderer. */
  onNotice?: (notice: LibraryNotice) => void
  /** Overridable so tests need no audio files. */
  readMetadata?: MetadataReader
  /** The same, for the readout pane's on-demand format lookup. */
  readFormatDetail?: FormatDetailReader
  /** Enables the derived artwork service. Omitted by tests that do not exercise it. */
  artworkCacheDir?: string
  readArtwork?: EmbeddedArtworkReader
  artworkProcessor?: ArtworkImageProcessor
  /**
   * Thumbnail hashes referenced from outside `library.db`.
   *
   * W7-13's artist photographs share the artwork directory but are referenced
   * from `cache.db`, so the prune has to be told about them or it deletes them
   * on the next reconcile. Passed straight through; see `ArtworkCacheDeps`.
   */
  externalArtworkReferences?: () => Iterable<string>
  /** Cross-platform watcher test seam. */
  watchAdapter?: DirectoryWatchAdapter
  watchDebounceMs?: number
  watchSettleMs?: number
  /** Test seam; production uses the packaged worker-thread adapter. */
  createReplayGainAnalyzer?: () => ReplayGainAnalyzer
  /**
   * Reads `audio.replayGainComputeWhenMissing`.
   *
   * A predicate rather than the settings service, so this stays a library
   * service that happens to be told one thing rather than one that can reach
   * every key. Omitting it means the job is always allowed, which is what the
   * tests want.
   */
  canComputeReplayGain?: () => boolean
}

function conflictMessage(conflict: RootConflict): string {
  switch (conflict.relation) {
    case 'same':
      return 'That folder is already in your library.'
    // Both nesting cases would index the same files under two roots, giving
    // every affected track two ids and two rows in every list.
    case 'inside':
      return 'That folder is inside one already in your library.'
    case 'contains':
      return 'That folder contains one already in your library. Remove the inner folder first.'
  }
}

function toLibraryRoot(row: RootRow, watchMode: LibraryWatchMode): LibraryRoot {
  return {
    id: row.id,
    path: row.path,
    addedAt: new Date(row.addedAt).toISOString(),
    trackCount: row.trackCount,
    watchMode
  }
}

export class SqliteLibraryService implements LibraryService {
  private readonly store: LibraryStore
  private readonly readMetadata: MetadataReader
  private readonly readFormatDetail: FormatDetailReader
  private readonly replayGain: ReplayGainJobService
  private readonly watcher: RootDirectoryWatcher
  private readonly artwork: ArtworkCacheService | null
  private readonly watchModes = new Map<number, LibraryWatchMode>()
  private readonly degradedRoots = new Set<number>()
  private readonly watchQueues = new Map<number, Promise<void>>()
  private artworkQueue: Promise<void> = Promise.resolve()
  private initialized = false
  private closing = false

  /**
   * Scans currently running, keyed by root.
   *
   * Two scans of one root would race on the same rows for no benefit, and the
   * flow makes it easy to ask for: `addRoot` starts one in the background, and
   * nothing stops the renderer calling `scanRoot` on it a moment later. Sharing
   * the in-flight promise makes the second call wait for the first rather than
   * duplicating it.
   */
  private readonly inFlight = new Map<number, Promise<ScanSummary>>()

  constructor(private readonly deps: SqliteLibraryDeps) {
    this.store = new LibraryStore(deps.db)
    this.readMetadata = deps.readMetadata ?? readTrackTags
    this.readFormatDetail = deps.readFormatDetail ?? readTrackFormatDetail
    this.artwork = deps.artworkCacheDir
      ? new ArtworkCacheService({
          store: this.store,
          cacheDir: deps.artworkCacheDir,
          ...(deps.readArtwork ? { readArtwork: deps.readArtwork } : {}),
          ...(deps.artworkProcessor ? { processor: deps.artworkProcessor } : {}),
          ...(deps.externalArtworkReferences
            ? { externalReferences: deps.externalArtworkReferences }
            : {})
        })
      : null
    this.replayGain = new ReplayGainJobService({
      db: deps.db,
      onProgress: deps.onReplayGainProgress ?? (() => {}),
      ...(deps.createReplayGainAnalyzer ? { createAnalyzer: deps.createReplayGainAnalyzer } : {}),
      ...(deps.canComputeReplayGain ? { canCompute: deps.canComputeReplayGain } : {})
    })
    this.watcher = new RootDirectoryWatcher({
      ...(deps.watchAdapter ? { adapter: deps.watchAdapter } : {}),
      ...(deps.watchDebounceMs !== undefined ? { debounceMs: deps.watchDebounceMs } : {}),
      ...(deps.watchSettleMs !== undefined ? { settleMs: deps.watchSettleMs } : {}),
      onPaths: (rootId, paths) => this.queueWatchReconcile(rootId, paths),
      onModeChange: (rootId, mode, error) => this.setWatchMode(rootId, mode, error),
      onFinding: ({ rootId, path, error }) => {
        console.warn(`[watch] root ${rootId} skipped ${path}:`, error)
      }
    })
  }

  /**
   * Performs the cheap startup reconciliation, then attaches live watchers.
   * Idempotent so application lifecycle wiring cannot duplicate subscriptions.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await Promise.all(
      this.store.listRoots().map(async (root) => {
        this.watchModes.set(root.id, 'starting')
        await this.startScan(root.id, true)
      })
    )
  }

  async addRoot(): Promise<LibraryRoot | null> {
    const picked = await this.deps.pickFolder()
    if (picked === null) return null

    // Normalised before it is compared or stored, so `.` and `..` segments and
    // a trailing separator cannot make one folder look like two.
    const path = resolve(picked)

    try {
      const info = await stat(path)
      if (!info.isDirectory()) {
        throw new FermataError('invalid-request', 'That is not a folder.')
      }
    } catch (error) {
      if (error instanceof FermataError) throw error
      throw new FermataError('io-error', 'That folder could not be opened.')
    }

    const conflict = this.store.findRootConflict(path)
    if (conflict) throw new FermataError('conflict', conflictMessage(conflict))

    // `basename` is empty for a drive root such as `C:\`, where the path itself
    // is the only sensible label.
    const root = this.store.insertRoot(path, basename(path) || path, Date.now())

    // Deliberately not awaited: a scan of a real library takes minutes, and the
    // renderer is waiting on this call to render the new root. Progress arrives
    // on `library.scanProgress`, and the final event carries `done`.
    void this.startScan(root.id).catch((error: unknown) => {
      console.error(`[scan] root ${root.id} failed:`, error)
    })

    return toLibraryRoot(root, 'starting')
  }

  async listRoots(): Promise<LibraryRoot[]> {
    return this.store
      .listRoots()
      .map((root) => toLibraryRoot(root, this.watchModes.get(root.id) ?? 'starting'))
  }

  async scanRoot(rootId: number): Promise<ScanSummary> {
    return this.startScan(rootId)
  }

  async listTracks(query: ListTracksQuery): Promise<ListTracksResult> {
    return this.store.listTracks(query)
  }

  async listTrackIds(query: ListTrackIdsQuery): Promise<ListTrackIdsResult> {
    return this.store.listTrackIds(query)
  }

  async listTrackGroups(query: ListTrackGroupsQuery): Promise<ListTrackGroupsResult> {
    return this.store.listTrackGroups(query)
  }

  async orderTrackIds(query: OrderTrackIdsQuery): Promise<number[]> {
    return this.store.orderTrackIds(query)
  }

  async getTracksByIds(query: GetTracksByIdsQuery): Promise<Track[]> {
    return this.store.getTracksByIds(query)
  }

  /**
   * W7-5. Composition and strategy live in `./related`; this is the wiring.
   *
   * The default neighbourhood strategy is applied by `buildRelated` rather than
   * named here, so the day a better one lands there is one call site to change
   * and it is not this one. W10-9's bias is forwarded rather than defaulted here
   * for the same reason: `undefined` means `ignore`, and `buildRelated` is the
   * one place that says so.
   */
  async getRelated(query: RelatedQuery): Promise<RelatedResult | null> {
    return buildRelated(this.store.relatedQueries(), query.trackId, {
      favorites: query.favorites
    })
  }

  async listArtists(query: ListFacetsQuery): Promise<ListArtistsResult> {
    return this.store.listArtists(query)
  }

  async listAlbums(query: ListFacetsQuery): Promise<ListAlbumsResult> {
    return this.store.listAlbums(query)
  }

  async listArtistIds(query: ListFacetIdsQuery): Promise<ListFacetIdsResult> {
    return this.store.listArtistIds(query)
  }

  async listAlbumIds(query: ListFacetIdsQuery): Promise<ListFacetIdsResult> {
    return this.store.listAlbumIds(query)
  }

  async getTrackAudioMetadata(trackId: number): Promise<TrackAudioMetadata | null> {
    return this.store.getTrackAudioMetadata(trackId)
  }

  async getTrackFormatDetail(trackId: number): Promise<TrackFormatDetail | null> {
    // The path is resolved here and dropped here. It reaches the parser and
    // nothing else, which is the same arrangement `registerTrackProtocol` uses
    // and for the same reason: the renderer asked with an id and gets back
    // format facts, never a location.
    const absPath = this.store.resolveTrackPath(trackId)
    if (absPath === null) return null
    return this.readFormatDetail(absPath)
  }

  async resolveTrackPath(trackId: number): Promise<string | null> {
    return this.store.resolveTrackPath(trackId)
  }

  async startReplayGain(): Promise<ReplayGainJobProgress> {
    return this.replayGain.start()
  }

  async getReplayGainJob(): Promise<ReplayGainJobProgress | null> {
    return this.replayGain.get()
  }

  async cancelReplayGain(jobId: number): Promise<ReplayGainJobProgress> {
    return this.replayGain.cancel(jobId)
  }

  async resumeReplayGain(jobId: number): Promise<ReplayGainJobProgress> {
    return this.replayGain.resume(jobId)
  }

  /**
   * Forgets a library folder. The files on disk are never touched.
   *
   * Ordered the way it is because each step depends on the one before:
   *
   * 1. Stop watching, *before* the rows go. A watcher that fires against a
   *    deleted root would reconcile a folder the library no longer has, and
   *    `queueWatchReconcile` would happily scan it back in.
   * 2. Wait out any scan already running for this root. Deleting rows from
   *    under a scan that is mid-transaction is how a half-removed root
   *    survives a restart — and the wait is bounded, because step 1 means
   *    nothing new can start one.
   * 3. Delete, and prune what the cascade cannot reach (see `store.removeRoot`).
   * 4. Sweep the artwork cache, which is now holding files for albums that no
   *    longer exist.
   *
   * The per-root state maps are cleared last. They are keyed by root id and
   * SQLite reuses ids, so an entry left behind here is one the *next* folder to
   * be added could inherit — a new root starting life marked degraded because
   * the one before it was.
   */
  async removeRoot(rootId: number): Promise<LibraryRoot[]> {
    this.watcher.stopRoot(rootId)

    const running = this.inFlight.get(rootId)
    if (running) await running.catch(() => {})
    const queued = this.watchQueues.get(rootId)
    if (queued) await queued.catch(() => {})

    const removed = this.store.removeRoot(rootId)

    this.watchModes.delete(rootId)
    this.degradedRoots.delete(rootId)
    this.watchQueues.delete(rootId)
    this.inFlight.delete(rootId)

    // Only when something actually went: a no-op removal has created no
    // unreferenced files, and sweeping the cache is a directory walk.
    if (removed) await this.artwork?.sweep()

    return this.listRoots()
  }

  async close(): Promise<void> {
    this.closing = true
    this.watcher.close()
    await Promise.allSettled([...this.inFlight.values(), ...this.watchQueues.values()])
    await this.artworkQueue.catch(() => {})
    await this.artwork?.close()
    await this.replayGain.close()
  }

  private startScan(rootId: number, incremental = false): Promise<ScanSummary> {
    const running = this.inFlight.get(rootId)
    if (running) return running

    const root = this.store.getRoot(rootId)
    if (!root) {
      return Promise.reject(
        new FermataError('not-found', 'That folder is no longer in your library.')
      )
    }

    if (this.initialized) {
      this.watcher.stopRoot(rootId)
      this.watchModes.set(rootId, 'starting')
    }

    const changedAlbums = new Set<number>()
    let completedProgress: ScanProgress | null = null
    const run = scanRoot(this.store, root, {
      readMetadata: this.readMetadata,
      // `done` means the renderer may safely refresh all library data. Hold it
      // until derived artwork has caught up with the rows the scan just wrote.
      onProgress: (progress) => {
        if (progress.done) completedProgress = progress
        else this.deps.onProgress(progress)
      },
      incremental,
      onAlbumsChanged: (albumIds) => {
        for (const albumId of albumIds) changedAlbums.add(albumId)
      }
    })
      .then(async (summary) => {
        const artworkAlbums = incremental
          ? this.store.listAlbumIdsUnderDirectories(root.id, [''])
          : changedAlbums
        await this.queueArtwork([...artworkAlbums], !incremental)
        if (completedProgress) this.deps.onProgress(completedProgress)
        return summary
      })
      .finally(async () => {
        this.inFlight.delete(rootId)
        if (this.initialized && !this.closing) {
          if (this.degradedRoots.has(root.id)) {
            this.watchModes.set(root.id, 'startup-scan-only')
          } else {
            await this.watcher.startRoot(root)
          }
        }
      })

    this.inFlight.set(rootId, run)
    return run
  }

  private queueWatchReconcile(rootId: number, paths: readonly string[]): Promise<void> {
    const previous = this.watchQueues.get(rootId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        const running = this.inFlight.get(rootId)
        if (running) await running
        const root = this.store.getRoot(rootId)
        if (!root || this.closing) return
        const changedAlbums = new Set<number>()
        let completedProgress: ScanProgress | null = null
        const sidecarDirectories = paths
          .filter(isArtworkSidecarPath)
          .map((path) => toRelativeDirectory(root.path, dirname(path)))
          .filter((path): path is string => path !== null)
        await reconcilePaths(this.store, root, paths, {
          readMetadata: this.readMetadata,
          onProgress: (progress) => {
            if (progress.done) completedProgress = progress
            else this.deps.onProgress(progress)
          },
          onAlbumsChanged: (albumIds) => {
            for (const albumId of albumIds) changedAlbums.add(albumId)
          }
        })
        for (const albumId of this.store.listAlbumIdsUnderDirectories(rootId, sidecarDirectories)) {
          changedAlbums.add(albumId)
        }
        await this.queueArtwork([...changedAlbums], true)
        if (completedProgress) this.deps.onProgress(completedProgress)
      })
      .finally(() => {
        if (this.watchQueues.get(rootId) === next) this.watchQueues.delete(rootId)
      })
    this.watchQueues.set(rootId, next)
    return next
  }

  private setWatchMode(rootId: number, mode: WatchMode, error?: unknown): void {
    const previous = this.watchModes.get(rootId)
    this.watchModes.set(rootId, mode)
    if (mode !== 'startup-scan-only' || previous === mode) return

    this.degradedRoots.add(rootId)
    console.warn(`[watch] root ${rootId} degraded to startup-scan-only:`, error)
    this.deps.onNotice?.({
      kind: 'watch-degraded',
      rootId,
      code: 'ENOSPC',
      message:
        'Live library updates are unavailable because Linux exhausted its inotify watches. ' +
        'Increase fs.inotify.max_user_watches, then restart Fermata. This folder will still ' +
        'be reconciled at startup.'
    })
  }

  private queueArtwork(albumIds?: readonly number[], force = false): Promise<void> {
    if (!this.artwork || albumIds?.length === 0) return Promise.resolve()
    const next = this.artworkQueue
      .catch(() => {})
      .then(async () => {
        try {
          await this.artwork!.reconcile(albumIds, force)
        } catch (error) {
          // Artwork is derived data. Cache I/O or a worker failure may leave a
          // placeholder temporarily, but must never turn a valid music scan
          // into a failed scan.
          console.warn('[artwork] reconciliation failed:', error)
        }
      })
    this.artworkQueue = next
    return next
  }
}

function toRelativeDirectory(rootPath: string, directory: string): string | null {
  if (resolve(rootPath) === resolve(directory)) return ''
  const relative = toRelPath(rootPath, directory)
  return relative
}
