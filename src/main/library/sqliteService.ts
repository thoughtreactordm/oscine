import type Database from 'better-sqlite3'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { OscineError } from '@shared/errors'
import type { ArtworkRef } from '@shared/artwork'
import {
  MAX_TRACK_ID_PAGE,
  type GetTracksByIdsQuery,
  type LibraryNotice,
  type LibraryRoot,
  type LibraryWatchMode,
  type ListAlbumsResult,
  type ListArtistsResult,
  type ListFacetIdsQuery,
  type ListFacetIdsResult,
  type ListFacetsQuery,
  type ListTagFacetsQuery,
  type ListTrackGroupsQuery,
  type ListTrackGroupsResult,
  type ListTrackIdsQuery,
  type ListTrackIdsResult,
  type ListTracksQuery,
  type ListTracksResult,
  type OrderTrackIdsQuery,
  type ReplayGainJobProgress,
  type ScanProgress,
  type ScanSummary,
  type TagFacet,
  type Track,
  type TrackAudioMetadata,
  type TrackFacets,
  type TrackFormatDetail
} from '@shared/library'
import type { RelatedQuery, RelatedResult } from '@shared/related'
import type { AlbumCard } from '@shared/albums'
import type { DiscoverRecipeId, DiscoverShelvesResult } from '@shared/discover'
import {
  OVERRIDE_FIELDS,
  type OverrideEditState,
  type OverrideField,
  type OverridePatch
} from '@shared/overrides'
import type { WritebackField } from '@shared/tagWriteback'
import { buildRelated } from './related'
import { DiscoverEngine, expandShelfTrackIds, snapshotShelf } from './discover'
import {
  readTrackFormatDetail,
  readTrackTags,
  type FormatDetailReader,
  type MetadataReader,
  type TrackTags
} from './metadata'
import type { EmbeddedArtworkReader } from './metadata'
import { reconcilePaths, scanRoot } from './scanner'
import { LibraryStore, type RootConflict, type RootRow } from './store'
import { ArtworkCacheService, isArtworkSidecarPath } from './artwork'
import { createArtworkOriginalsStore, type ArtworkOriginalsStore } from './artworkOriginals'
import type { ArtworkImageProcessor } from './artworkProcessor'
import { resolveArtworkIntent, type ArtworkWriteIntent } from './writeback/writer'
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
  /**
   * Opens the OS image picker for a cover ingest — **W16-10**. Resolves the
   * chosen absolute path, or `null` when the operator cancels. Injected like
   * `pickFolder` so this file stays Electron-free and testable against a temp
   * directory; `src/main/index.ts` supplies the real one.
   */
  pickImageFile?: () => Promise<string | null>
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
  /**
   * Enables W16-9's override-originals store, held alongside the reconcile pass
   * so a satisfied artwork override retires and its bytes are GC'd. Omitted and
   * the artwork override reconcile is skipped.
   */
  artworkOriginalsDir?: string
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
  private readonly originals: ArtworkOriginalsStore | null
  private readonly discover: DiscoverEngine
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
    this.discover = new DiscoverEngine(deps.db)
    this.readMetadata = deps.readMetadata ?? readTrackTags
    this.readFormatDetail = deps.readFormatDetail ?? readTrackFormatDetail
    this.originals = deps.artworkOriginalsDir
      ? createArtworkOriginalsStore({ dir: deps.artworkOriginalsDir })
      : null
    this.artwork = deps.artworkCacheDir
      ? new ArtworkCacheService({
          store: this.store,
          cacheDir: deps.artworkCacheDir,
          ...(this.originals ? { originals: this.originals } : {}),
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
        throw new OscineError('invalid-request', 'That is not a folder.')
      }
    } catch (error) {
      if (error instanceof OscineError) throw error
      throw new OscineError('io-error', 'That folder could not be opened.')
    }

    const conflict = this.store.findRootConflict(path)
    if (conflict) throw new OscineError('conflict', conflictMessage(conflict))

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

  async trackFacets(trackId: number): Promise<TrackFacets> {
    return this.store.trackFacets(trackId)
  }

  async getOverrideEditState(trackIds: readonly number[]): Promise<OverrideEditState> {
    return this.store.overrideEditState(trackIds)
  }

  async setOverrides(request: {
    trackIds: readonly number[]
    patch: OverridePatch
  }): Promise<void> {
    this.store.setOverrides(request.trackIds, request.patch, Date.now())
  }

  async clearOverrides(request: {
    trackIds: readonly number[]
    fields: readonly OverrideField[]
  }): Promise<void> {
    // Reverting needs the file's current tags; main reads them here and the store
    // re-materialises them. A file that cannot be read keeps its correction.
    const entries: { trackId: number; file: TrackTags }[] = []
    for (const trackId of new Set(request.trackIds)) {
      const absPath = this.store.resolveTrackPath(trackId)
      if (absPath === null) continue
      try {
        entries.push({ trackId, file: await this.readMetadata(absPath) })
      } catch {
        // Unreadable file — leave its override in place rather than guess a revert.
      }
    }
    this.store.revertOverrides(entries, request.fields, Date.now())
  }

  async pendingWritebackTrackIds(): Promise<number[]> {
    return this.store.pendingWritebackTrackIds()
  }

  async discardAllOverrides(): Promise<void> {
    const trackIds = this.store.pendingWritebackTrackIds()
    if (trackIds.length === 0) return
    // Reverting every field of every edited track re-reads each file and restores
    // it — a deliberate, bounded cost for a deliberate destructive action.
    await this.clearOverrides({ trackIds, fields: OVERRIDE_FIELDS })
    this.store.removeArtworkOverrides(trackIds)
    await this.gcArtworkOriginals()
  }

  async retireWrittenOverrides(trackId: number, fields: readonly WritebackField[]): Promise<void> {
    this.store.retireWrittenOverrides(trackId, fields, Date.now())
    if (fields.includes('artwork')) await this.gcArtworkOriginals()
  }

  /** Releases originals no live artwork override still names (R8). */
  private async gcArtworkOriginals(): Promise<void> {
    if (!this.originals) return
    await this.originals.gc(this.store.listReferencedOverrideImageHashes())
  }

  /**
   * The front-cover intent a flush should write, resolved from the override
   * store and the originals bytes *now* — **W16-11**, R7. No override is
   * `unchanged`; a missing originals store (tests that never wired one) is the
   * same, so a scalar flush cannot fail for want of a cover it cannot load.
   */
  async artworkWriteIntent(trackId: number): Promise<ArtworkWriteIntent> {
    const originals = this.originals
    if (originals === null) return { kind: 'unchanged' }
    return resolveArtworkIntent({
      override: this.store.getArtworkOverride(trackId),
      readOriginal: (hash) => originals.read(hash)
    })
  }

  async setArtworkFromDialog(trackIds: readonly number[]): Promise<ArtworkRef | null> {
    const artwork = this.requireArtwork()
    const picked = this.deps.pickImageFile ? await this.deps.pickImageFile() : null
    // Cancelling is an ordinary outcome, not an error — the contract says so.
    if (picked === null) return null
    let bytes: Uint8Array
    try {
      bytes = await readFile(picked)
    } catch {
      // The abs path never crosses the wire (renderer-never-sees-abs-path); the
      // detail is dropped here and the operator gets a safe, generic message.
      throw new OscineError('io-error', 'That image could not be read.')
    }
    return artwork.setCover(trackIds, bytes)
  }

  async setArtworkFromBytes(
    trackIds: readonly number[],
    bytes: Uint8Array,
    // The renderer's declared type is advisory: `setCover` re-sniffs the real
    // one from the bytes and never trusts this. Kept on the signature so the
    // one-way drag/drop/paste payload matches the bridge surface.
    _mime: string
  ): Promise<ArtworkRef> {
    return this.requireArtwork().setCover(trackIds, bytes)
  }

  async clearArtwork(trackIds: readonly number[]): Promise<void> {
    await this.requireArtwork().clearCover(trackIds)
  }

  async revertArtwork(trackIds: readonly number[]): Promise<void> {
    await this.requireArtwork().revertCover(trackIds)
  }

  /** The artwork service, or a typed failure on a library wired without one. */
  private requireArtwork(): ArtworkCacheService {
    if (!this.artwork) {
      throw new OscineError('internal', 'Artwork is unavailable on this library.')
    }
    return this.artwork
  }

  async recentlyAddedAlbums(limit: number): Promise<AlbumCard[]> {
    return this.store.recentlyAddedAlbums(limit)
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

  async discoverShelves(): Promise<DiscoverShelvesResult> {
    return this.discover.shelves()
  }

  /**
   * The last `shelves` result, expanded to track ids in Library album order.
   *
   * Does not re-compose. A subsequent `compose` that would have picked
   * differently does not change this snapshot — that is the whole of what
   * "save what you are looking at" means.
   */
  async discoverSaveShelf(
    recipeId: DiscoverRecipeId
  ): Promise<{ name: string; trackIds: number[] }> {
    const snapshot = snapshotShelf(this.discover.lastResult(), recipeId)
    const expanded = expandShelfTrackIds(snapshot.items, (albumId) => this.albumTrackIds(albumId))
    // Hydrate drops ids the library no longer has, in the order given, so a
    // track-grain card whose file vanished between the wall and the click
    // does not blow the playlist write on a foreign key.
    const trackIds = this.store.getTracksByIds({ ids: expanded }).map((track) => track.id)
    return { name: snapshot.name, trackIds }
  }

  /**
   * Every track on an album, disc / track / id — the same `trackNo` sort a
   * Library album activation uses. Paged against the id ceiling, not because
   * a Discover album will reach it, but because `listTrackIds` will refuse a
   * larger `limit` and a truncated expansion would be the wrong playlist.
   */
  private albumTrackIds(albumId: number): number[] {
    const ids: number[] = []
    for (;;) {
      const page = this.store.listTrackIds({
        albumIds: [albumId],
        sort: 'trackNo',
        direction: 'asc',
        offset: ids.length,
        limit: MAX_TRACK_ID_PAGE
      })
      if (page.ids.length === 0) return ids
      ids.push(...page.ids)
      if (ids.length >= page.total) return ids
    }
  }

  async listArtists(query: ListFacetsQuery): Promise<ListArtistsResult> {
    return this.store.listArtists(query)
  }

  async listAlbums(query: ListFacetsQuery): Promise<ListAlbumsResult> {
    return this.store.listAlbums(query)
  }

  async listTagFacets(query: ListTagFacetsQuery): Promise<TagFacet[]> {
    return this.store.listTagFacets(query)
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
        new OscineError('not-found', 'That folder is no longer in your library.')
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
