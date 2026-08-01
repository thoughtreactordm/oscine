import type Database from 'better-sqlite3'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { FermataError } from '@shared/errors'
import type {
  AddTracksToPlaylistRequest,
  ExportPlaylistRequest,
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryGroupsQuery,
  ListPlaylistEntryGroupsResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  MovePlaylistEntriesRequest,
  Playlist,
  PlaylistExportResult,
  RemovePlaylistEntriesRequest
} from '@shared/playlists'
import { renderM3u8, suggestedFileName, withM3u8Extension, type M3uTrack } from './m3u8'
import { PlaylistStore } from './store'

/**
 * Everything the IPC layer needs from playlists, and nothing more.
 *
 * The same seam `LibraryService` draws, for the same reason: the handlers
 * validate and delegate, and never learn that there is a `position` column
 * behind any of this. Async because the boundary is, not because the store is —
 * SQLite is synchronous, and pretending otherwise here would be a lie the
 * handlers would have to keep.
 */
export interface PlaylistService {
  list(): Promise<Playlist[]>
  create(name: string): Promise<Playlist>
  rename(playlistId: number, name: string): Promise<Playlist>
  delete(playlistId: number): Promise<void>
  reorder(playlistId: number, toIndex: number): Promise<Playlist[]>
  listEntries(query: ListPlaylistEntriesQuery): Promise<ListPlaylistEntriesResult>
  listEntryIds(query: ListPlaylistEntryIdsQuery): Promise<ListPlaylistEntryIdsResult>
  listEntryGroups(query: ListPlaylistEntryGroupsQuery): Promise<ListPlaylistEntryGroupsResult>
  addTracks(request: AddTracksToPlaylistRequest): Promise<Playlist>
  moveEntries(request: MovePlaylistEntriesRequest): Promise<Playlist>
  removeEntries(request: RemovePlaylistEntriesRequest): Promise<Playlist>
  /** Resolves `null` when the operator dismisses the save dialog. */
  exportM3u8(request: ExportPlaylistRequest): Promise<PlaylistExportResult | null>
}

export interface SqlitePlaylistDeps {
  db: Database.Database
  /**
   * Opens the OS save dialog on a suggested filename. Resolves `null` when the
   * operator cancels.
   *
   * Injected for the reason `SqliteLibraryDeps.pickFolder` is: Electron appears
   * nowhere in this file, so the whole export path — including the writing of a
   * real file — is drivable from a test with a temp directory and no
   * application.
   */
  pickExportFile: (suggestedName: string) => Promise<string | null>
  /** Injectable so a test can assert on `updatedAt` without racing the clock. */
  now?: () => number
}

export class SqlitePlaylistService implements PlaylistService {
  private readonly store: PlaylistStore
  private readonly now: () => number
  private readonly pickExportFile: SqlitePlaylistDeps['pickExportFile']

  constructor(deps: SqlitePlaylistDeps) {
    this.store = new PlaylistStore(deps.db)
    this.now = deps.now ?? (() => Date.now())
    this.pickExportFile = deps.pickExportFile
  }

  async list(): Promise<Playlist[]> {
    return this.store.list()
  }

  async create(name: string): Promise<Playlist> {
    return this.store.create(name, this.now())
  }

  async rename(playlistId: number, name: string): Promise<Playlist> {
    return this.store.rename(playlistId, name, this.now())
  }

  async delete(playlistId: number): Promise<void> {
    this.store.delete(playlistId)
  }

  async reorder(playlistId: number, toIndex: number): Promise<Playlist[]> {
    return this.store.reorder(playlistId, toIndex, this.now())
  }

  async listEntries(query: ListPlaylistEntriesQuery): Promise<ListPlaylistEntriesResult> {
    return this.store.listEntries(query)
  }

  async listEntryIds(query: ListPlaylistEntryIdsQuery): Promise<ListPlaylistEntryIdsResult> {
    return this.store.listEntryIds(query)
  }

  async listEntryGroups(
    query: ListPlaylistEntryGroupsQuery
  ): Promise<ListPlaylistEntryGroupsResult> {
    return this.store.listEntryGroups(query)
  }

  async addTracks(request: AddTracksToPlaylistRequest): Promise<Playlist> {
    return this.store.addTracks(request.playlistId, request.trackIds, request.insertion, this.now())
  }

  async moveEntries(request: MovePlaylistEntriesRequest): Promise<Playlist> {
    return this.store.moveEntries(
      request.playlistId,
      request.entryIds,
      request.insertion,
      this.now()
    )
  }

  async removeEntries(request: RemovePlaylistEntriesRequest): Promise<Playlist> {
    return this.store.removeEntries(request.playlistId, request.entryIds, this.now())
  }

  /**
   * D12's escape hatch: the playlist, as a file another player can open.
   *
   * The snapshot is read before the dialog opens, so what lands on disk is what
   * the operator was looking at when they asked, rather than whatever a
   * background rescan left behind while they browsed for a folder. Entries
   * whose file no longer resolves are counted out rather than written as a
   * broken line — a playlist that names a file that is not there is a playlist
   * every player will complain about, once per entry.
   *
   * Nothing here is written through `store`: this is the one operation in the
   * playlist surface that touches a path outside the library, and keeping it in
   * the service is what keeps the store's promise that it only speaks SQL.
   */
  async exportM3u8(request: ExportPlaylistRequest): Promise<PlaylistExportResult | null> {
    const snapshot = this.store.readForExport(request.playlistId)

    const picked = await this.pickExportFile(suggestedFileName(snapshot.name))
    if (picked === null) return null
    const destination = withM3u8Extension(picked)

    // `flatMap` rather than `filter`, so the unresolved entries are narrowed out
    // of the type as well as out of the array.
    const tracks: M3uTrack[] = snapshot.entries.flatMap((entry) =>
      entry.absPath === null ? [] : [{ ...entry, absPath: entry.absPath }]
    )

    const text = renderM3u8(tracks, { destination, pathStyle: request.pathStyle })
    try {
      // UTF-8 spelled out rather than inherited from Node's default for a
      // string: the format is named after its encoding, so that is not a detail
      // to leave to a default someone could change under us.
      await writeFile(destination, text, 'utf8')
    } catch (error) {
      // The path is logged in main and deliberately not forwarded: an
      // `IpcErrorPayload` never carries one. See `toSafeError`.
      console.error(`[playlists] export to ${destination} failed:`, error)
      throw new FermataError('io-error', 'That playlist could not be written to disk.')
    }

    return {
      fileName: basename(destination),
      entryCount: tracks.length,
      skippedCount: snapshot.entries.length - tracks.length
    }
  }
}
