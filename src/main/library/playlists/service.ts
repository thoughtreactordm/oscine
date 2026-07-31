import type Database from 'better-sqlite3'
import type {
  AddTracksToPlaylistRequest,
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  MovePlaylistEntriesRequest,
  Playlist,
  RemovePlaylistEntriesRequest
} from '@shared/playlists'
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
  create(name: string, crossfadeMs: number): Promise<Playlist>
  rename(playlistId: number, name: string): Promise<Playlist>
  setCrossfade(playlistId: number, crossfadeMs: number): Promise<Playlist>
  delete(playlistId: number): Promise<void>
  reorder(playlistId: number, toIndex: number): Promise<Playlist[]>
  listEntries(query: ListPlaylistEntriesQuery): Promise<ListPlaylistEntriesResult>
  listEntryIds(query: ListPlaylistEntryIdsQuery): Promise<ListPlaylistEntryIdsResult>
  addTracks(request: AddTracksToPlaylistRequest): Promise<Playlist>
  moveEntries(request: MovePlaylistEntriesRequest): Promise<Playlist>
  removeEntries(request: RemovePlaylistEntriesRequest): Promise<Playlist>
}

export interface SqlitePlaylistDeps {
  db: Database.Database
  /** Injectable so a test can assert on `updatedAt` without racing the clock. */
  now?: () => number
}

export class SqlitePlaylistService implements PlaylistService {
  private readonly store: PlaylistStore
  private readonly now: () => number

  constructor(deps: SqlitePlaylistDeps) {
    this.store = new PlaylistStore(deps.db)
    this.now = deps.now ?? (() => Date.now())
  }

  async list(): Promise<Playlist[]> {
    return this.store.list()
  }

  async create(name: string, crossfadeMs: number): Promise<Playlist> {
    return this.store.create(name, crossfadeMs, this.now())
  }

  async rename(playlistId: number, name: string): Promise<Playlist> {
    return this.store.rename(playlistId, name, this.now())
  }

  async setCrossfade(playlistId: number, crossfadeMs: number): Promise<Playlist> {
    return this.store.setCrossfade(playlistId, crossfadeMs, this.now())
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
}
