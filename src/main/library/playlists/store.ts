import type Database from 'better-sqlite3'
import { FermataError } from '@shared/errors'
import type { TrackGroup } from '@shared/library'
import type {
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryGroupsQuery,
  ListPlaylistEntryGroupsResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  Playlist,
  PlaylistEntry,
  PlaylistInsertion
} from '@shared/playlists'
import { toAbsPath } from '../../db/paths'
import {
  ALBUM_GROUP_PROJECTION,
  ALBUM_MAJOR_ORDER,
  albumRunOrder,
  artworkUrls,
  TRACK_JOINS,
  TRACK_PROJECTION,
  toTrack,
  type TrackRow
} from '../store'
import { spread } from './positions'

/**
 * Every SQL statement the playlist layer issues.
 *
 * Schema v1 already ships `playlists`, `playlist_entries`, the REAL `position`
 * column and both indexes, so there is nothing to migrate — this is the module
 * that finally uses them.
 *
 * Electron-free, like `../store`: the whole playlist surface is exercisable
 * under plain Node against a temp file.
 */

export interface PlaylistRow {
  id: number
  name: string
  trackCount: number
  createdAt: number
  updatedAt: number
}

interface EntryRow extends TrackRow {
  entryId: number
}

/** The stored halves of a path, plus the three fields a `#EXTINF` record needs. */
interface ExportRow {
  rootPath: string
  relPath: string
  durationMs: number | null
  artist: string | null
  title: string | null
}

/** One entry, rejoined against its root for this platform. */
export interface PlaylistExportEntry {
  /** Null when the stored `rel_path` no longer resolves inside its root. */
  absPath: string | null
  durationSec: number | null
  artist: string | null
  title: string
}

/** A whole playlist, ready to render. */
export interface PlaylistExportSnapshot {
  name: string
  entries: PlaylistExportEntry[]
}

/** The projection every playlist read shares. Tab order is `position`. */
export const PLAYLIST_PROJECTION = `
  p.id           AS id,
  p.name         AS name,
  p.created_at   AS createdAt,
  p.updated_at   AS updatedAt,
  (SELECT count(*) FROM playlist_entries e WHERE e.playlist_id = p.id) AS trackCount
`

function prepareStatements(db: Database.Database) {
  return {
    list: db.prepare(`
      SELECT ${PLAYLIST_PROJECTION}
      FROM playlists p
      ORDER BY p.position ASC, p.id ASC
    `),
    get: db.prepare(`
      SELECT ${PLAYLIST_PROJECTION}
      FROM playlists p
      WHERE p.id = ?
    `),
    nextTabPosition: db.prepare(
      'SELECT COALESCE(max(position), -1) + 1 AS position FROM playlists'
    ),
    insert: db.prepare(`
      INSERT INTO playlists (name, position, created_at, updated_at)
      VALUES (@name, @position, @now, @now)
      RETURNING id
    `),
    rename: db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM playlists WHERE id = ?'),
    setTabPosition: db.prepare('UPDATE playlists SET position = ? WHERE id = ?'),
    listTabIds: db.prepare('SELECT id FROM playlists ORDER BY position ASC, id ASC'),
    touch: db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?'),

    countEntries: db.prepare(
      'SELECT count(*) AS total FROM playlist_entries WHERE playlist_id = ?'
    ),
    // Both reads go through `idx_playlist_entries_playlist`, which is
    // (playlist_id, position) — the ORDER BY is served by the index rather than
    // by a sort over the whole playlist, which is what keeps a page cheap at
    // the far end of a 20,000-entry list.
    listEntryIds: db.prepare(`
      SELECT id
      FROM playlist_entries
      WHERE playlist_id = @playlistId
      ORDER BY position ASC, id ASC
      LIMIT @limit OFFSET @offset
    `),
    listEntries: db.prepare(`
      SELECT e.id AS entryId, ${TRACK_PROJECTION}
      FROM playlist_entries e
      JOIN tracks t ON t.id = e.track_id
      ${TRACK_JOINS}
      WHERE e.playlist_id = @playlistId
      ORDER BY e.position ASC, e.id ASC
      LIMIT @limit OFFSET @offset
    `),
    /**
     * The same two windows, album-major.
     *
     * Separate prepared statements rather than an interpolated ORDER BY: the
     * order is one of two fixed shapes, and building SQL from a request field
     * is the habit this file does not want even where the field is validated.
     *
     * Both join `tracks`, including the ids query, which the position-ordered
     * one does not have to — the ordering lives across the join. That is the
     * cost of the view and it is paid only while it is on.
     *
     * `e.id` is the tiebreaker, never `t.id`: D12 makes the same track legal
     * twice in one playlist, so two entries can tie on every album key and on
     * the track id too. Without a total order they swap between pages and the
     * pane shows one row twice while skipping another.
     */
    listEntryIdsByAlbum: db.prepare(`
      SELECT e.id AS id
      FROM playlist_entries e
      JOIN tracks t ON t.id = e.track_id
      ${TRACK_JOINS}
      WHERE e.playlist_id = @playlistId
      ORDER BY ${ALBUM_MAJOR_ORDER}, e.id ASC
      LIMIT @limit OFFSET @offset
    `),
    listEntriesByAlbum: db.prepare(`
      SELECT e.id AS entryId, ${TRACK_PROJECTION}
      FROM playlist_entries e
      JOIN tracks t ON t.id = e.track_id
      ${TRACK_JOINS}
      WHERE e.playlist_id = @playlistId
      ORDER BY ${ALBUM_MAJOR_ORDER}, e.id ASC
      LIMIT @limit OFFSET @offset
    `),
    /**
     * One row per album run, in the same order the rows above come out in.
     *
     * `count(*)` counts *entries*, not distinct tracks — a playlist holding a
     * record twice has a run two long, and a header claiming one would leave
     * the layout's prefix sums one short of the list they index into.
     */
    listEntryGroups: db.prepare(`
      SELECT ${ALBUM_GROUP_PROJECTION},
             count(*) AS trackCount
      FROM playlist_entries e
      JOIN tracks t ON t.id = e.track_id
      ${TRACK_JOINS}
      WHERE e.playlist_id = @playlistId
      GROUP BY t.album_id
      ORDER BY ${albumRunOrder('ASC')}
    `),
    /**
     * The whole playlist, as paths rather than as display rows.
     *
     * Unpaged, unlike every other list in the codebase, and deliberately: an
     * export is one file and a playlist half-written is worse than one not
     * written at all, so there is no window here to get the arithmetic of
     * wrong. The rows are three strings and a number each — a 20,000-entry
     * playlist is a few megabytes held for the length of one write.
     *
     * `roots` is joined rather than assumed: an entry's root is the one its
     * track was stored under, and D12 lets a playlist span several of them.
     * Only the track's own artist is projected, because that is the name the
     * contents pane shows and an export that disagreed with the list it came
     * from would be a bug report nobody could reproduce.
     */
    listExportEntries: db.prepare(`
      SELECT r.path        AS rootPath,
             t.rel_path    AS relPath,
             t.duration_ms AS durationMs,
             ar.name       AS artist,
             t.title       AS title
      FROM playlist_entries e
      JOIN tracks t ON t.id = e.track_id
      JOIN roots  r ON r.id = t.root_id
      LEFT JOIN artists ar ON ar.id = t.artist_id
      WHERE e.playlist_id = @playlistId
      ORDER BY e.position ASC, e.id ASC
    `),
    entryPosition: db.prepare(
      'SELECT position FROM playlist_entries WHERE id = ? AND playlist_id = ?'
    ),
    /**
     * The neighbour immediately outside a position, ignoring a set of entries.
     *
     * The exclusion is what makes a move correct: when a selection is dragged,
     * the row above the drop point may itself be part of the selection and is
     * about to leave. Computing the gap against rows that are staying puts the
     * moved block where the user dropped it rather than where it used to be.
     */
    previousPosition: db.prepare(`
      SELECT max(position) AS position
      FROM playlist_entries
      WHERE playlist_id = @playlistId
        AND position < @position
        AND id NOT IN (SELECT value FROM json_each(@excluded))
    `),
    nextPosition: db.prepare(`
      SELECT min(position) AS position
      FROM playlist_entries
      WHERE playlist_id = @playlistId
        AND position > @position
        AND id NOT IN (SELECT value FROM json_each(@excluded))
    `),
    boundaryPosition: db.prepare(`
      SELECT min(position) AS first, max(position) AS last
      FROM playlist_entries
      WHERE playlist_id = @playlistId
        AND id NOT IN (SELECT value FROM json_each(@excluded))
    `),

    /**
     * A whole multi-selection in one statement.
     *
     * `json_each` over a single JSON parameter rather than a placeholder list,
     * for the same reason `hydrateTracks` does it: a placeholder list
     * re-compiles for every distinct length, and a drag can be any length. The
     * join against `tracks` drops ids that no longer exist — a selection can
     * outlive a rescan — instead of failing the whole batch on one stale row.
     */
    insertEntries: db.prepare(`
      INSERT INTO playlist_entries (playlist_id, track_id, position)
      SELECT @playlistId,
             json_extract(pair.value, '$[0]'),
             json_extract(pair.value, '$[1]')
      FROM json_each(@rows) pair
      JOIN tracks t ON t.id = json_extract(pair.value, '$[0]')
      ORDER BY pair.key
    `),
    moveEntry: db.prepare(
      'UPDATE playlist_entries SET position = ? WHERE id = ? AND playlist_id = ?'
    ),
    removeEntries: db.prepare(`
      DELETE FROM playlist_entries
      WHERE playlist_id = @playlistId
        AND id IN (SELECT value FROM json_each(@ids))
    `),
    /**
     * Renumbers a playlist to 1..n in position order.
     *
     * The escape hatch for exhausted float precision, and the only operation
     * here that touches rows it was not asked about. `row_number()` keeps it a
     * single statement — reading the ids out and updating them one at a time
     * would be a round trip per entry on the one operation that already
     * touches every entry.
     */
    rebalance: db.prepare(`
      UPDATE playlist_entries
      SET position = (
        SELECT ranked.rank
        FROM (
          SELECT id, row_number() OVER (ORDER BY position ASC, id ASC) AS rank
          FROM playlist_entries
          WHERE playlist_id = @playlistId
        ) ranked
        WHERE ranked.id = playlist_entries.id
      )
      WHERE playlist_id = @playlistId
    `),
    orderedEntryIds: db.prepare(`
      SELECT id
      FROM playlist_entries
      WHERE playlist_id = @playlistId
        AND id IN (SELECT value FROM json_each(@ids))
      ORDER BY position ASC, id ASC
    `)
  }
}

export function toPlaylist(row: PlaylistRow): Playlist {
  return {
    id: row.id,
    name: row.name,
    trackCount: row.trackCount,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString()
  }
}

function notFound(): never {
  throw new FermataError('not-found', 'That playlist no longer exists.')
}

/** The interval an insertion resolves to, `null` meaning unbounded. */
interface Gap {
  after: number | null
  before: number | null
}

export class PlaylistStore {
  private readonly statements: ReturnType<typeof prepareStatements>

  constructor(private readonly db: Database.Database) {
    this.statements = prepareStatements(db)
  }

  list(): Playlist[] {
    return (this.statements.list.all() as PlaylistRow[]).map(toPlaylist)
  }

  get(playlistId: number): Playlist | null {
    const row = this.statements.get.get(playlistId) as PlaylistRow | undefined
    return row === undefined ? null : toPlaylist(row)
  }

  private require(playlistId: number): Playlist {
    return this.get(playlistId) ?? notFound()
  }

  create(name: string, now: number): Playlist {
    const { position } = this.statements.nextTabPosition.get() as { position: number }
    const { id } = this.statements.insert.get({ name, position, now }) as {
      id: number
    }
    return this.require(id)
  }

  rename(playlistId: number, name: string, now: number): Playlist {
    if (this.statements.rename.run(name, now, playlistId).changes === 0) notFound()
    return this.require(playlistId)
  }

  /**
   * Deletes a playlist and, by the schema's ON DELETE CASCADE, its entries.
   *
   * The tracks are untouched: `playlist_entries.track_id` points at the
   * library, and the cascade runs the other way.
   */
  delete(playlistId: number): void {
    if (this.statements.delete.run(playlistId).changes === 0) notFound()
  }

  /**
   * Moves a tab to `toIndex`, renumbering the bar.
   *
   * Renumbering the whole thing is right here and wrong for entries, and the
   * difference is the count: tabs are a handful of rows the user made by hand,
   * entries are tens of thousands. `toIndex` is clamped rather than validated —
   * a drag past the end of the bar means "last", which is what the user did.
   */
  reorder(playlistId: number, toIndex: number, now: number): Playlist[] {
    const apply = this.db.transaction(() => {
      const ids = (this.statements.listTabIds.all() as Array<{ id: number }>).map((row) => row.id)
      const from = ids.indexOf(playlistId)
      if (from === -1) notFound()

      const [moved] = ids.splice(from, 1)
      ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, moved)
      ids.forEach((id, index) => {
        this.statements.setTabPosition.run(index, id)
      })
      this.statements.touch.run(now, playlistId)
    })
    apply()
    return this.list()
  }

  listEntries(query: ListPlaylistEntriesQuery): ListPlaylistEntriesResult {
    const total = this.countEntries(query.playlistId)
    const statement =
      query.order === 'album' ? this.statements.listEntriesByAlbum : this.statements.listEntries
    const rows = statement.all({
      playlistId: query.playlistId,
      limit: query.limit,
      offset: query.offset
    }) as EntryRow[]
    const entries: PlaylistEntry[] = rows.map((row) => ({ id: row.entryId, track: toTrack(row) }))
    return { entries, total }
  }

  /**
   * The album runs of a playlist, and the entries they account for.
   *
   * `total` comes from the same `countEntries` the row query reports rather
   * than from summing the runs, so the renderer can compare the two and fall
   * back to an ungrouped list when they disagree — which is exactly what
   * happens for the moment between an edit and the reload that follows it.
   */
  listEntryGroups(query: ListPlaylistEntryGroupsQuery): ListPlaylistEntryGroupsResult {
    const rows = this.statements.listEntryGroups.all({
      playlistId: query.playlistId
    }) as Array<Omit<TrackGroup, 'artwork'> & { artworkHash: string | null }>
    return {
      groups: rows.map(({ artworkHash, ...group }) => ({
        ...group,
        artwork: artworkUrls(artworkHash)
      })),
      total: this.countEntries(query.playlistId)
    }
  }

  /**
   * Everything an export needs, in one read.
   *
   * The name comes back with the entries because the save dialog opens on it,
   * and asking twice would leave a window in which the playlist is renamed
   * between the two calls. Unknown ids throw here rather than at the dialog, so
   * exporting a tab someone deleted in another window fails before the operator
   * has typed a filename.
   *
   * This is the one place outside `../store` that rejoins a stored path, and it
   * uses the same helper for the same reason: `toAbsPath` is what makes a
   * `rel_path` written on Windows resolve against a Linux root, and it is also
   * the containment check that keeps a corrupted row from naming a file outside
   * the library. A row that fails it comes back as `null` rather than as a
   * guess.
   */
  readForExport(playlistId: number): PlaylistExportSnapshot {
    const playlist = this.require(playlistId)
    const rows = this.statements.listExportEntries.all({ playlistId }) as ExportRow[]
    return {
      name: playlist.name,
      entries: rows.map((row) => ({
        absPath: toAbsPath(row.rootPath, row.relPath),
        // Milliseconds to seconds exactly as `toTrack` does it, so the number
        // in the file is the number the list showed.
        durationSec: row.durationMs === null ? null : row.durationMs / 1000,
        artist: row.artist,
        title: row.title ?? ''
      }))
    }
  }

  listEntryIds(query: ListPlaylistEntryIdsQuery): ListPlaylistEntryIdsResult {
    const total = this.countEntries(query.playlistId)
    // The same branch `listEntries` makes, and it has to be the same: a
    // Shift-range resolves through here against index positions the operator
    // read off the rows, so the two must describe one list.
    const statement =
      query.order === 'album' ? this.statements.listEntryIdsByAlbum : this.statements.listEntryIds
    const rows = statement.all({
      playlistId: query.playlistId,
      limit: query.limit,
      offset: query.offset
    }) as Array<{ id: number }>
    return { ids: rows.map((row) => row.id), total }
  }

  /**
   * Appends or inserts a multi-selection, in one statement inside one
   * transaction.
   *
   * Duplicate `trackIds` are kept: D12 makes the same track legal twice, and
   * `playlist_entries.id` is what tells the two rows apart afterwards.
   */
  addTracks(
    playlistId: number,
    trackIds: readonly number[],
    insertion: PlaylistInsertion,
    now: number
  ): Playlist {
    const playlist = this.require(playlistId)
    if (trackIds.length === 0) return playlist

    const write = this.db.transaction(() => {
      const positions = this.allocate(playlistId, insertion, trackIds.length, [])
      const rows = trackIds.map((trackId, index) => [trackId, positions[index]])
      this.statements.insertEntries.run({ playlistId, rows: JSON.stringify(rows) })
      this.statements.touch.run(now, playlistId)
    })
    write()
    return this.require(playlistId)
  }

  /**
   * Relocates entries already in the playlist, preserving their relative order.
   *
   * A drop onto the moved selection itself is a no-op rather than an error: it
   * is a gesture users make, and there is no coherent answer to "put these
   * before themselves" worth interrupting them over.
   */
  moveEntries(
    playlistId: number,
    entryIds: readonly number[],
    insertion: PlaylistInsertion,
    now: number
  ): Playlist {
    const playlist = this.require(playlistId)
    if (entryIds.length === 0) return playlist

    const anchorId =
      insertion.at === 'before' || insertion.at === 'after' ? insertion.entryId : null
    if (anchorId !== null && entryIds.includes(anchorId)) return playlist

    const write = this.db.transaction(() => {
      // In playlist order, not in the order the caller happened to list them.
      // The caller is a selection, and a selection is a set; the block has to
      // land reading the way it read before it was dragged.
      const ordered = (
        this.statements.orderedEntryIds.all({
          playlistId,
          ids: JSON.stringify([...entryIds])
        }) as Array<{ id: number }>
      ).map((row) => row.id)
      if (ordered.length === 0) return

      const positions = this.allocate(playlistId, insertion, ordered.length, ordered)
      ordered.forEach((entryId, index) => {
        this.statements.moveEntry.run(positions[index], entryId, playlistId)
      })
      this.statements.touch.run(now, playlistId)
    })
    write()
    return this.require(playlistId)
  }

  removeEntries(playlistId: number, entryIds: readonly number[], now: number): Playlist {
    const playlist = this.require(playlistId)
    if (entryIds.length === 0) return playlist

    const write = this.db.transaction(() => {
      this.statements.removeEntries.run({ playlistId, ids: JSON.stringify([...entryIds]) })
      this.statements.touch.run(now, playlistId)
    })
    write()
    return this.require(playlistId)
  }

  private countEntries(playlistId: number): number {
    const { total } = this.statements.countEntries.get(playlistId) as { total: number }
    return total
  }

  /**
   * `count` positions for an insertion, rebalancing first if the gap cannot
   * hold them.
   *
   * Callers run inside a transaction, so a rebalance and the insert that forced
   * it commit together — a crash between the two would otherwise leave the
   * playlist renumbered and the drop lost, which reads to the user as the drag
   * having silently failed.
   *
   * The retry is unconditional after a rebalance rather than a loop: renumbering
   * leaves integer gaps of 1, and an interval of width 1 holds far more doubles
   * than `MAX_PLAYLIST_BATCH` entries. If that still fails the invariant is
   * broken somewhere else and looping would only hide it.
   */
  private allocate(
    playlistId: number,
    insertion: PlaylistInsertion,
    count: number,
    excluded: readonly number[]
  ): number[] {
    const first = this.resolveGap(playlistId, insertion, excluded)
    const positions = spread(first.after, first.before, count)
    if (positions !== null) return positions

    this.statements.rebalance.run({ playlistId })

    const second = this.resolveGap(playlistId, insertion, excluded)
    const rebalanced = spread(second.after, second.before, count)
    if (rebalanced !== null) return rebalanced

    throw new FermataError('internal', 'That playlist is too large to reorder any further.')
  }

  /** Turns an insertion anchor into the interval it names. */
  private resolveGap(
    playlistId: number,
    insertion: PlaylistInsertion,
    excluded: readonly number[]
  ): Gap {
    const ids = JSON.stringify([...excluded])

    if (insertion.at === 'start' || insertion.at === 'end') {
      const bounds = this.statements.boundaryPosition.get({ playlistId, excluded: ids }) as {
        first: number | null
        last: number | null
      }
      return insertion.at === 'start'
        ? { after: null, before: bounds.first }
        : { after: bounds.last, before: null }
    }

    const anchor = this.statements.entryPosition.get(insertion.entryId, playlistId) as
      { position: number } | undefined
    if (anchor === undefined) {
      throw new FermataError('not-found', 'That playlist row is no longer there.')
    }

    if (insertion.at === 'before') {
      const { position } = this.statements.previousPosition.get({
        playlistId,
        position: anchor.position,
        excluded: ids
      }) as { position: number | null }
      return { after: position, before: anchor.position }
    }

    const { position } = this.statements.nextPosition.get({
      playlistId,
      position: anchor.position,
      excluded: ids
    }) as { position: number | null }
    return { after: anchor.position, before: position }
  }
}
