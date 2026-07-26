import { FermataError } from '@shared/errors'
import type {
  LibraryRoot,
  ListTracksQuery,
  ListTracksResult,
  ScanSummary
} from '@shared/library'

/**
 * Everything the IPC layer needs from the library, and nothing more.
 *
 * The seam exists so W1-3 can land a complete, typed boundary before W2 has a
 * database behind it. W2-1 and W2-2 replace the implementation; the contract,
 * the validation and the preload bridge do not move.
 */
export interface LibraryService {
  addRoot(): Promise<LibraryRoot | null>
  listRoots(): Promise<LibraryRoot[]>
  scanRoot(rootId: number): Promise<ScanSummary>
  listTracks(query: ListTracksQuery): Promise<ListTracksResult>
  /**
   * Absolute path for a track id, or `null` if unknown.
   *
   * Only ever called inside main — by the `fermata://` protocol handler. The
   * return value never crosses IPC.
   */
  resolveTrackPath(trackId: number): Promise<string | null>
}

/**
 * Stand-in until W2-1 lands the database.
 *
 * It answers honestly rather than plausibly: with no database there genuinely
 * are no roots and no tracks, so those return empty. Operations that cannot be
 * answered at all fail loudly instead of returning fabricated data that would
 * make W4 look like it works.
 */
export class PendingLibraryService implements LibraryService {
  private unavailable(): never {
    throw new FermataError('internal', 'The music library is not available yet.')
  }

  async addRoot(): Promise<LibraryRoot | null> {
    this.unavailable()
  }

  async listRoots(): Promise<LibraryRoot[]> {
    return []
  }

  async scanRoot(_rootId: number): Promise<ScanSummary> {
    this.unavailable()
  }

  async listTracks(_query: ListTracksQuery): Promise<ListTracksResult> {
    return { tracks: [], total: 0 }
  }

  async resolveTrackPath(_trackId: number): Promise<string | null> {
    return null
  }
}
