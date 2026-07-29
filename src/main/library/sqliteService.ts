import type Database from 'better-sqlite3'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { FermataError } from '@shared/errors'
import type {
  LibraryRoot,
  ListTracksQuery,
  ListTracksResult,
  ScanProgress,
  ScanSummary
} from '@shared/library'
import { readTrackTags, type MetadataReader } from './metadata'
import { scanRoot } from './scanner'
import { LibraryStore, type RootConflict, type RootRow } from './store'
import type { LibraryService } from './service'

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
  /** Overridable so tests need no audio files. */
  readMetadata?: MetadataReader
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

function toLibraryRoot(row: RootRow): LibraryRoot {
  return {
    id: row.id,
    path: row.path,
    addedAt: new Date(row.addedAt).toISOString(),
    trackCount: row.trackCount
  }
}

export class SqliteLibraryService implements LibraryService {
  private readonly store: LibraryStore
  private readonly readMetadata: MetadataReader

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

    return toLibraryRoot(root)
  }

  async listRoots(): Promise<LibraryRoot[]> {
    return this.store.listRoots().map(toLibraryRoot)
  }

  async scanRoot(rootId: number): Promise<ScanSummary> {
    return this.startScan(rootId)
  }

  async listTracks(query: ListTracksQuery): Promise<ListTracksResult> {
    return this.store.listTracks(query)
  }

  async resolveTrackPath(trackId: number): Promise<string | null> {
    return this.store.resolveTrackPath(trackId)
  }

  private startScan(rootId: number): Promise<ScanSummary> {
    const running = this.inFlight.get(rootId)
    if (running) return running

    const root = this.store.getRoot(rootId)
    if (!root) {
      return Promise.reject(
        new FermataError('not-found', 'That folder is no longer in your library.')
      )
    }

    const run = scanRoot(this.store, root, {
      readMetadata: this.readMetadata,
      onProgress: this.deps.onProgress
    }).finally(() => {
      this.inFlight.delete(rootId)
    })

    this.inFlight.set(rootId, run)
    return run
  }
}
