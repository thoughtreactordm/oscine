import type Database from 'better-sqlite3'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { OscineError } from '@shared/errors'
import type {
  AddTracksToPlaylistRequest,
  ClearPlaylistExclusionsRequest,
  ExportPlaylistRequest,
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryGroupsQuery,
  ListPlaylistEntryGroupsResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  MovePlaylistEntriesRequest,
  Playlist,
  PlaylistExclusion,
  PlaylistExclusionSource,
  PlaylistExportResult,
  PlaylistKind,
  RemovePlaylistEntriesRequest
} from '@shared/playlists'
import { NO_LIBRARY_CHANGES, type LibraryChangeNotifier } from '../changes'
import { renderM3u8, suggestedFileName, withM3u8Extension, type M3uTrack } from './m3u8'
import { PlaylistStore, type ExclusionEffect } from './store'

/**
 * Who is editing a playlist's entries, which is what decides its exclusions
 * (D36.8). The default is the operator, so every caller that does not say —
 * the IPC handlers, Discover's save — gets the operator's rules.
 *
 * - `operator`: removing a track from a smart playlist excludes it (once no
 *   entry still names it); adding a track by hand clears its exclusion.
 * - `agent`: an add to a smart playlist skips excluded tracks and stamps
 *   `refreshed_at`; a removal excludes only when asked (`exclude`).
 * - `restore`: the journal putting entries back as they were. Exclusions are
 *   their own journaled field, so a restore never touches them — otherwise
 *   reverting an agent's add to a smart playlist would exclude what it took out.
 */
export type PlaylistEditActor = 'operator' | 'agent' | 'restore'

export interface PlaylistEditOptions {
  actor?: PlaylistEditActor
  /** An agent's removal from a smart playlist: keep the removed tracks out. */
  exclude?: boolean
}

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
  addTracks(request: AddTracksToPlaylistRequest, options?: PlaylistEditOptions): Promise<Playlist>
  moveEntries(request: MovePlaylistEntriesRequest): Promise<Playlist>
  removeEntries(
    request: RemovePlaylistEntriesRequest,
    options?: PlaylistEditOptions
  ): Promise<Playlist>
  /** Make smart / Make static (D36.8). The brief, notes and exclusions are kept either way. */
  setKind(playlistId: number, kind: PlaylistKind): Promise<Playlist>
  /** The operator's brief; null or blank clears it. */
  setBrief(playlistId: number, brief: string | null): Promise<Playlist>
  /** The agent's notes; stamps `refreshed_at`. */
  setAgentNotes(playlistId: number, notes: string | null): Promise<Playlist>
  listExclusions(playlistId: number): Promise<PlaylistExclusion[]>
  /** Excludes tracks directly — the journal restoring a reverted clear. */
  addExclusions(
    playlistId: number,
    trackIds: readonly number[],
    source: PlaylistExclusionSource
  ): Promise<Playlist>
  clearExclusions(request: ClearPlaylistExclusionsRequest): Promise<Playlist>
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
  /** Announces each committed write as `library.changed` (D36.9). Silent when omitted. */
  changes?: LibraryChangeNotifier
}

export class SqlitePlaylistService implements PlaylistService {
  private readonly store: PlaylistStore
  private readonly now: () => number
  private readonly pickExportFile: SqlitePlaylistDeps['pickExportFile']
  private readonly changes: LibraryChangeNotifier

  constructor(deps: SqlitePlaylistDeps) {
    this.store = new PlaylistStore(deps.db)
    this.now = deps.now ?? (() => Date.now())
    this.pickExportFile = deps.pickExportFile
    this.changes = deps.changes ?? NO_LIBRARY_CHANGES
  }

  async list(): Promise<Playlist[]> {
    return this.store.list()
  }

  async create(name: string): Promise<Playlist> {
    const playlist = this.store.create(name, this.now())
    this.changes.notify({ playlists: [playlist.id] })
    return playlist
  }

  async rename(playlistId: number, name: string): Promise<Playlist> {
    const playlist = this.store.rename(playlistId, name, this.now())
    this.changes.notify({ playlists: [playlistId] })
    return playlist
  }

  async delete(playlistId: number): Promise<void> {
    this.store.delete(playlistId)
    this.changes.notify({ playlists: [playlistId], playlistEntries: [playlistId] })
  }

  async reorder(playlistId: number, toIndex: number): Promise<Playlist[]> {
    const list = this.store.reorder(playlistId, toIndex, this.now())
    // Every position after the moved row shifted, so the whole rail order is news.
    this.changes.notify({ playlists: 'all' })
    return list
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

  async addTracks(
    request: AddTracksToPlaylistRequest,
    options: PlaylistEditOptions = {}
  ): Promise<Playlist> {
    const actor = options.actor ?? 'operator'
    const smart = this.isSmart(request.playlistId)
    const effect: ExclusionEffect =
      actor === 'operator'
        ? { clearOnAdd: true }
        : actor === 'agent' && smart
          ? { skipExcluded: true }
          : {}
    const now = this.now()
    let playlist = this.store.addTracks(
      request.playlistId,
      request.trackIds,
      request.insertion,
      now,
      effect
    )
    if (actor === 'agent' && smart) {
      this.store.stampRefreshed(request.playlistId, now)
      playlist = this.store.get(request.playlistId) ?? playlist
    }
    this.notifyEntries(request.playlistId)
    return playlist
  }

  async moveEntries(request: MovePlaylistEntriesRequest): Promise<Playlist> {
    const playlist = this.store.moveEntries(
      request.playlistId,
      request.entryIds,
      request.insertion,
      this.now()
    )
    this.notifyEntries(request.playlistId)
    return playlist
  }

  async removeEntries(
    request: RemovePlaylistEntriesRequest,
    options: PlaylistEditOptions = {}
  ): Promise<Playlist> {
    const actor = options.actor ?? 'operator'
    const smart = this.isSmart(request.playlistId)
    const excludeOnRemove: PlaylistExclusionSource | null = !smart
      ? null
      : actor === 'operator'
        ? 'operator'
        : actor === 'agent' && options.exclude === true
          ? 'agent'
          : null
    const playlist = this.store.removeEntries(request.playlistId, request.entryIds, this.now(), {
      excludeOnRemove
    })
    this.notifyEntries(request.playlistId)
    return playlist
  }

  async setKind(playlistId: number, kind: PlaylistKind): Promise<Playlist> {
    const playlist = this.store.setKind(playlistId, kind, this.now())
    this.changes.notify({ playlists: [playlistId] })
    return playlist
  }

  async setBrief(playlistId: number, brief: string | null): Promise<Playlist> {
    const playlist = this.store.setBrief(playlistId, blankToNull(brief), this.now())
    this.changes.notify({ playlists: [playlistId] })
    return playlist
  }

  async setAgentNotes(playlistId: number, notes: string | null): Promise<Playlist> {
    const playlist = this.store.setAgentNotes(playlistId, blankToNull(notes), this.now())
    this.changes.notify({ playlists: [playlistId] })
    return playlist
  }

  async listExclusions(playlistId: number): Promise<PlaylistExclusion[]> {
    return this.store.listExclusions(playlistId)
  }

  async addExclusions(
    playlistId: number,
    trackIds: readonly number[],
    source: PlaylistExclusionSource
  ): Promise<Playlist> {
    this.store.addExclusions(playlistId, trackIds, source, this.now())
    this.changes.notify({ playlists: [playlistId] })
    return this.store.get(playlistId) ?? notFound()
  }

  async clearExclusions(request: ClearPlaylistExclusionsRequest): Promise<Playlist> {
    this.store.clearExclusions(request.playlistId, request.trackIds ?? null)
    this.changes.notify({ playlists: [request.playlistId] })
    return this.store.get(request.playlistId) ?? notFound()
  }

  private isSmart(playlistId: number): boolean {
    return this.store.get(playlistId)?.kind === 'smart'
  }

  /**
   * One event for an entry edit however many rows it moved. The playlist row is
   * named too: its count and `updatedAt` moved with the entries.
   */
  private notifyEntries(playlistId: number): void {
    this.changes.notify({ playlists: [playlistId], playlistEntries: [playlistId] })
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
      throw new OscineError('io-error', 'That playlist could not be written to disk.')
    }

    return {
      fileName: basename(destination),
      entryCount: tracks.length,
      skippedCount: snapshot.entries.length - tracks.length
    }
  }
}

function blankToNull(text: string | null): string | null {
  const trimmed = text?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

function notFound(): never {
  throw new OscineError('not-found', 'That playlist no longer exists.')
}
