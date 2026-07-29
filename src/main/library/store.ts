import type Database from 'better-sqlite3'
import type { ListTracksQuery, ListTracksResult, Track, TrackSortColumn } from '@shared/library'
import { relateRoots, toAbsPath, type RootRelation } from '../db/paths'
import type { TrackTags } from './metadata'
import { fileStem, type AudioFile } from './walk'

/**
 * Every SQL statement the library layer issues.
 *
 * Concentrated in one class so the scanner and the service stay free of schema
 * knowledge, and so the statements are prepared once rather than per row — on a
 * 100k-track scan that difference is measured in whole seconds.
 *
 * Electron-free by design, in the same spirit as `src/main/db`: the entire
 * scan-and-query path is exercisable under plain Node with a temp file.
 */

export interface RootRow {
  id: number
  path: string
  label: string
  /** Epoch milliseconds. */
  addedAt: number
  lastScanAt: number | null
  trackCount: number
}

/** A file the walk found and the parser understood. */
export interface ScannedTrack {
  file: AudioFile
  tags: TrackTags
}

export interface RootConflict {
  relation: Exclude<RootRelation, 'unrelated'>
  existing: RootRow
}

interface SortKey {
  /**
   * A SQL fragment from the closed table below — never a value from a request.
   * `assertEveryChannelHandled`'s sibling guarantee: `sort` is validated at the
   * IPC boundary, and it is re-checked here because a fragment reaching an
   * ORDER BY on the strength of a type annotation alone is one refactor away
   * from being an injection point.
   */
  readonly expr: string
  /** Text keys fold case; numeric ones must not. */
  readonly text?: boolean
  /** Suppresses the nulls-last prefix for expressions that cannot be NULL. */
  readonly notNull?: boolean
}

const SORT_KEYS: Record<TrackSortColumn, readonly SortKey[]> = {
  // Disc before track, so a multi-disc album reads in playing order rather than
  // interleaving disc 2's track 1 with disc 1's. Single-disc albums tag no disc
  // at all, hence the COALESCE rather than a nulls-last prefix.
  trackNo: [{ expr: 'COALESCE(t.disc_no, 1)', notNull: true }, { expr: 't.track_no' }],
  title: [{ expr: 't.title', text: true }],
  artist: [{ expr: 'ar.name', text: true }],
  album: [{ expr: 'al.title', text: true }],
  durationSec: [{ expr: 't.duration_ms' }]
}

interface JoinedSort {
  /** Table holding the displayed value, scanned in its indexed order. */
  readonly table: 'artists' | 'albums'
  readonly alias: 'sort_ar' | 'sort_al'
  readonly index: 'idx_artists_order_name' | 'idx_albums_order_title'
  readonly trackIndex: 'idx_tracks_artist' | 'idx_tracks_album'
  readonly foreignKey: 'artist_id' | 'album_id'
  readonly value: string
}

/**
 * Sort keys that live across a join.
 *
 * Starting the ordinary track query from `tracks` makes SQLite look up the
 * artist/album for all 100k rows and sort the result. These definitions let the
 * query start at the already-ordered dimension instead, then find that
 * dimension's tracks through the existing foreign-key index. SQLite only has
 * to sort ids within one equal name/title group.
 */
const JOINED_SORTS: Partial<Record<TrackSortColumn, JoinedSort>> = {
  artist: {
    table: 'artists',
    alias: 'sort_ar',
    index: 'idx_artists_order_name',
    trackIndex: 'idx_tracks_artist',
    foreignKey: 'artist_id',
    value: 'sort_ar.name'
  },
  album: {
    table: 'albums',
    alias: 'sort_al',
    index: 'idx_albums_order_title',
    trackIndex: 'idx_tracks_album',
    foreignKey: 'album_id',
    value: 'sort_al.title'
  }
}

/**
 * Joins and projection shared by every list shape.
 *
 * `aa` is the album's artist, which is a different join from the track's own —
 * a compilation has one album artist and a different artist per track.
 */
const TRACK_JOINS = `
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums  al ON al.id = t.album_id
  LEFT JOIN artists aa ON aa.id = al.album_artist_id
`

const TRACK_PROJECTION = `
  t.id           AS id,
  t.root_id      AS rootId,
  t.title        AS title,
  ar.name        AS artist,
  al.title       AS album,
  aa.name        AS albumArtist,
  t.track_no     AS trackNo,
  t.disc_no      AS discNo,
  al.year        AS year,
  t.duration_ms  AS durationMs,
  t.codec        AS codec,
  t.size         AS encodedBytes,
  t.sample_rate  AS sampleRate,
  t.channels     AS channels,
  t.bit_depth    AS bitDepth
`

interface TrackRow {
  id: number
  rootId: number
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  trackNo: number | null
  discNo: number | null
  year: number | null
  durationMs: number | null
  codec: string | null
  encodedBytes: number
  sampleRate: number | null
  channels: number | null
  bitDepth: number | null
}

/** FTS5 has no NULL: a NULL column and an empty one are indistinguishable to it. */
function ftsText(value: string | null): string {
  return value ?? ''
}

/**
 * Prepared once per connection.
 *
 * A free function rather than an inline object so the field type is inferred
 * from the statements themselves — spelling out fifteen `Statement` annotations
 * would add nothing a reader cannot see and one more place to get out of step.
 */
function prepareStatements(db: Database.Database) {
  return {
    listRoots: db.prepare(`
      SELECT r.id           AS id,
             r.path         AS path,
             r.label        AS label,
             r.added_at     AS addedAt,
             r.last_scan_at AS lastScanAt,
             (SELECT count(*) FROM tracks t WHERE t.root_id = r.id) AS trackCount
      FROM roots r
      ORDER BY r.added_at ASC, r.id ASC
    `),
    getRoot: db.prepare(`
      SELECT r.id           AS id,
             r.path         AS path,
             r.label        AS label,
             r.added_at     AS addedAt,
             r.last_scan_at AS lastScanAt,
             (SELECT count(*) FROM tracks t WHERE t.root_id = r.id) AS trackCount
      FROM roots r
      WHERE r.id = ?
    `),
    insertRoot: db.prepare(
      'INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?) RETURNING id'
    ),
    markScanned: db.prepare('UPDATE roots SET last_scan_at = ? WHERE id = ?'),

    findArtist: db.prepare('SELECT id FROM artists WHERE name = ?'),
    insertArtist: db.prepare('INSERT INTO artists (name) VALUES (?) RETURNING id'),

    // `album_artist_id IS ?` rather than `= ?`. The UNIQUE(title,
    // album_artist_id) constraint does not constrain rows whose album artist is
    // NULL — SQLite treats every NULL as distinct — so an equality lookup would
    // miss the existing row and quietly create one album per track for any
    // album whose artist could not be determined.
    findAlbum: db.prepare('SELECT id FROM albums WHERE title = ? AND album_artist_id IS ?'),
    insertAlbum: db.prepare(
      'INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?) RETURNING id'
    ),
    // Only fills a gap. The first track of an album may be the untagged one.
    fillAlbumYear: db.prepare('UPDATE albums SET year = ? WHERE id = ? AND year IS NULL'),

    upsertTrack: db.prepare(`
      INSERT INTO tracks (
        root_id, rel_path, mtime, size, duration_ms, codec, sample_rate, channels,
        bit_depth, title, artist_id, album_id, track_no, disc_no,
        rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, rg_source
      ) VALUES (
        @rootId, @relPath, @mtime, @size, @durationMs, @codec, @sampleRate, @channels,
        @bitDepth, @title, @artistId, @albumId, @trackNo, @discNo,
        @rgTrackGain, @rgTrackPeak, @rgAlbumGain, @rgAlbumPeak, @rgSource
      )
      ON CONFLICT(root_id, rel_path) DO UPDATE SET
        mtime = excluded.mtime, size = excluded.size, duration_ms = excluded.duration_ms,
        codec = excluded.codec, sample_rate = excluded.sample_rate,
        channels = excluded.channels, bit_depth = excluded.bit_depth,
        title = excluded.title, artist_id = excluded.artist_id,
        album_id = excluded.album_id, track_no = excluded.track_no,
        disc_no = excluded.disc_no,
        rg_track_gain = excluded.rg_track_gain, rg_track_peak = excluded.rg_track_peak,
        rg_album_gain = excluded.rg_album_gain, rg_album_peak = excluded.rg_album_peak,
        rg_source = excluded.rg_source
      RETURNING id
    `),

    // Contentless FTS5 cannot delete by rowid alone: the 'delete' command has to
    // be handed the exact column values that were indexed, or the index is left
    // corrupt. They are read back from `tracks` rather than remembered, which is
    // what makes a re-scan of an already-indexed root idempotent.
    ftsSource: db.prepare(`
      SELECT t.id                  AS id,
             COALESCE(t.title, '') AS title,
             COALESCE(ar.name, '') AS artist,
             COALESCE(al.title,'') AS album
      FROM tracks t
      LEFT JOIN artists ar ON ar.id = t.artist_id
      LEFT JOIN albums  al ON al.id = t.album_id
      WHERE t.root_id = ? AND t.rel_path = ?
    `),
    ftsDelete: db.prepare(
      "INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album) VALUES('delete', ?, ?, ?, ?)"
    ),
    ftsInsert: db.prepare(
      'INSERT INTO tracks_fts (rowid, title, artist, album) VALUES (?, ?, ?, ?)'
    ),

    resolveTrack: db.prepare(`
      SELECT r.path AS rootPath, t.rel_path AS relPath
      FROM tracks t
      JOIN roots r ON r.id = t.root_id
      WHERE t.id = ?
    `)
  }
}

export class LibraryStore {
  private readonly statements: ReturnType<typeof prepareStatements>

  /**
   * Memoised id lookups, valid for the life of the process.
   *
   * Safe only because nothing deletes an artist or an album — M1 has no such
   * operation. Whoever adds one in M3 must clear these, or a rescan will attach
   * tracks to a row that no longer exists.
   */
  private readonly artistIds = new Map<string, number>()
  private readonly albumIds = new Map<string, number>()

  constructor(private readonly db: Database.Database) {
    this.statements = prepareStatements(db)
  }

  listRoots(): RootRow[] {
    return this.statements.listRoots.all() as RootRow[]
  }

  getRoot(rootId: number): RootRow | null {
    return (this.statements.getRoot.get(rootId) as RootRow | undefined) ?? null
  }

  /**
   * The first registered root that would overlap `candidatePath`, if any.
   *
   * Linear over the roots table, which holds a handful of rows — the user picks
   * these by hand. Containment cannot be expressed as a SQL predicate anyway
   * without reimplementing the platform's path semantics in SQLite.
   */
  findRootConflict(candidatePath: string): RootConflict | null {
    for (const existing of this.listRoots()) {
      const relation = relateRoots(existing.path, candidatePath)
      if (relation !== 'unrelated') return { relation, existing }
    }
    return null
  }

  insertRoot(path: string, label: string, addedAt: number): RootRow {
    const { id } = this.statements.insertRoot.get(label, path, addedAt) as { id: number }
    return { id, path, label, addedAt, lastScanAt: null, trackCount: 0 }
  }

  markScanned(rootId: number, at: number): void {
    this.statements.markScanned.run(at, rootId)
  }

  /**
   * Writes one batch inside a single transaction.
   *
   * Batching is what keeps a scan from blocking the main process for long
   * stretches: better-sqlite3 is synchronous, so the whole batch is one
   * uninterruptible span and the caller yields to the event loop between calls.
   *
   * The transaction also makes the id caches safe. They are populated as rows
   * are written, so a rollback would leave them naming rows that no longer
   * exist — hence the clear on failure.
   */
  writeTracks(rootId: number, entries: readonly ScannedTrack[]): void {
    if (entries.length === 0) return

    const write = this.db.transaction((items: readonly ScannedTrack[]) => {
      for (const item of items) this.writeTrack(rootId, item)
    })

    try {
      write(entries)
    } catch (error) {
      this.artistIds.clear()
      this.albumIds.clear()
      throw error
    }
  }

  private writeTrack(rootId: number, { file, tags }: ScannedTrack): void {
    const artistId = tags.artist === null ? null : this.upsertArtist(tags.artist)

    // The card's compilation rule. Without the fallback, an album whose tracks
    // carry no ALBUMARTIST resolves to album_artist_id NULL for every track —
    // and because NULLs do not collide in a UNIQUE constraint, the album
    // shatters into one row per track.
    const albumArtistId = tags.albumArtist === null ? artistId : this.upsertArtist(tags.albumArtist)

    const albumId =
      tags.album === null ? null : this.upsertAlbum(tags.album, albumArtistId, tags.year)

    // Foobar's behaviour, and the reason `Track.title` is non-nullable across
    // IPC: a file with no title tag shows its filename rather than a blank row.
    // The correction path for a wrong title is `track_overrides` (D7), not this.
    const title = tags.title ?? fileStem(file.relPath)

    const previous = this.statements.ftsSource.get(rootId, file.relPath) as
      { id: number; title: string; artist: string; album: string } | undefined
    if (previous) {
      this.statements.ftsDelete.run(previous.id, previous.title, previous.artist, previous.album)
    }

    const gain = tags.replayGain
    const { id } = this.statements.upsertTrack.get({
      rootId,
      relPath: file.relPath,
      mtime: file.mtime,
      size: file.size,
      durationMs: tags.durationMs,
      codec: tags.codec,
      sampleRate: tags.sampleRate,
      channels: tags.channels,
      bitDepth: tags.bitDepth,
      title,
      artistId,
      albumId,
      trackNo: tags.trackNo,
      discNo: tags.discNo,
      rgTrackGain: gain?.trackGainDb ?? null,
      rgTrackPeak: gain?.trackPeak ?? null,
      rgAlbumGain: gain?.albumGainDb ?? null,
      rgAlbumPeak: gain?.albumPeak ?? null,
      // The card asks for these now because W3 reads them at M2 and computing
      // them is expensive. M2 also owns the question this leaves open: a rescan
      // currently overwrites a 'computed' row with the file's absent tags.
      rgSource: gain === null ? null : 'tag'
    }) as { id: number }

    this.statements.ftsInsert.run(id, ftsText(title), ftsText(tags.artist), ftsText(tags.album))
  }

  private upsertArtist(name: string): number {
    const cached = this.artistIds.get(name)
    if (cached !== undefined) return cached

    const found = this.statements.findArtist.get(name) as { id: number } | undefined
    const id = found?.id ?? (this.statements.insertArtist.get(name) as { id: number }).id

    this.artistIds.set(name, id)
    return id
  }

  private upsertAlbum(title: string, albumArtistId: number | null, year: number | null): number {
    // Keyed on the pair, because album identity is the pair: two artists with an
    // album called "Greatest Hits" have two different albums. JSON rather than a
    // separator character — any separator can also occur inside a title, and
    // then two distinct pairs spell one key and the albums merge.
    const key = JSON.stringify([albumArtistId, title])
    const cached = this.albumIds.get(key)
    if (cached !== undefined) {
      if (year !== null) this.statements.fillAlbumYear.run(year, cached)
      return cached
    }

    const found = this.statements.findAlbum.get(title, albumArtistId) as { id: number } | undefined
    let id: number
    if (found) {
      id = found.id
      if (year !== null) this.statements.fillAlbumYear.run(year, id)
    } else {
      id = (this.statements.insertAlbum.get(title, albumArtistId, year) as { id: number }).id
    }

    this.albumIds.set(key, id)
    return id
  }

  listTracks(query: ListTracksQuery): ListTracksResult {
    const keys = SORT_KEYS[query.sort]
    if (!keys) throw new Error(`Unsupported sort column: ${String(query.sort)}`)
    const direction = query.direction === 'desc' ? 'DESC' : 'ASC'
    const where = query.rootId === undefined ? '' : 'WHERE t.root_id = @rootId'
    const params = { rootId: query.rootId ?? null, limit: query.limit, offset: query.offset }

    const { total } = this.db
      .prepare(`SELECT count(*) AS total FROM tracks t ${where}`)
      .get(params) as { total: number }

    const joinedSort = JOINED_SORTS[query.sort]
    if (joinedSort) {
      return {
        tracks: this.listTracksByJoinedSort(query, joinedSort, direction),
        total
      }
    }

    // Nulls last in both directions: an untagged artist belongs at the bottom of
    // the list whichever way it is sorted, and SQLite's default puts NULL first
    // ascending. `t.id` is the tiebreaker — without a total order, two rows that
    // compare equal can swap between pages and a virtualized list shows one row
    // twice while skipping another.
    const orderBy = keys
      .map((key) => {
        const nullsLast = key.notNull ? '' : `${key.expr} IS NULL ASC, `
        const collate = key.text ? ' COLLATE NOCASE' : ''
        return `${nullsLast}${key.expr}${collate} ${direction}`
      })
      .join(', ')

    const rows = this.db
      .prepare(
        `SELECT ${TRACK_PROJECTION}
         FROM (
           SELECT t.id
           FROM tracks t
           ${where}
           ORDER BY ${orderBy}, t.id ASC
           LIMIT @limit OFFSET @offset
         ) page
         JOIN tracks t ON t.id = page.id
         ${TRACK_JOINS}
         ORDER BY ${orderBy}, t.id ASC`
      )
      .all(params) as TrackRow[]

    return { tracks: rows.map(toTrack), total }
  }

  /**
   * Reads an artist/album page without sorting the whole track table.
   *
   * The dimension table supplies non-null rows in indexed order. Null rows are
   * a separate id-ordered tail, which exactly matches listTracks' nulls-last
   * contract. Splitting the query also makes a page that crosses that boundary
   * cheap instead of forcing a compound-query sort.
   */
  private listTracksByJoinedSort(
    query: ListTracksQuery,
    sort: JoinedSort,
    direction: 'ASC' | 'DESC'
  ): Track[] {
    const rootPredicate = query.rootId === undefined ? '' : 'AND t.root_id = @rootId'
    const params = { rootId: query.rootId ?? null, limit: query.limit, offset: query.offset }
    const { total: taggedTotal } = this.db
      .prepare(
        `SELECT count(*) AS total
         FROM tracks t
         WHERE t.${sort.foreignKey} IS NOT NULL
         ${rootPredicate}`
      )
      .get(params) as { total: number }

    const rows: TrackRow[] = []
    const taggedAvailable = Math.max(0, taggedTotal - query.offset)
    const taggedLimit = Math.min(query.limit, taggedAvailable)

    if (taggedLimit > 0) {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT ${TRACK_PROJECTION}
             FROM (
               SELECT t.id, ${sort.value} AS sortValue
               FROM ${sort.table} ${sort.alias} INDEXED BY ${sort.index}
               JOIN tracks t INDEXED BY ${sort.trackIndex}
                 ON t.${sort.foreignKey} = ${sort.alias}.id
               WHERE 1 = 1
               ${rootPredicate}
               ORDER BY ${sort.value} COLLATE NOCASE ${direction}, t.id ASC
               LIMIT @limit OFFSET @offset
             ) page
             JOIN tracks t ON t.id = page.id
             ${TRACK_JOINS}
             ORDER BY page.sortValue COLLATE NOCASE ${direction}, t.id ASC`
          )
          .all({ ...params, limit: taggedLimit }) as TrackRow[])
      )
    }

    const nullLimit = query.limit - rows.length
    if (nullLimit > 0) {
      const nullOffset = Math.max(0, query.offset - taggedTotal)
      rows.push(
        ...(this.db
          .prepare(
            `SELECT ${TRACK_PROJECTION}
             FROM (
               SELECT t.id
               FROM tracks t
               WHERE t.${sort.foreignKey} IS NULL
               ${rootPredicate}
               ORDER BY t.id ASC
               LIMIT @limit OFFSET @offset
             ) page
             JOIN tracks t ON t.id = page.id
             ${TRACK_JOINS}
             ORDER BY t.id ASC`
          )
          .all({ ...params, limit: nullLimit, offset: nullOffset }) as TrackRow[])
      )
    }

    return rows.map(toTrack)
  }

  /**
   * Absolute path for a track, or `null` if the id is unknown or the stored
   * `rel_path` no longer resolves inside its root.
   *
   * The containment check is `toAbsPath`'s, and it is the last line of defence
   * for the `fermata://` handler — see the note in `db/paths.ts`.
   */
  resolveTrackPath(trackId: number): string | null {
    const row = this.statements.resolveTrack.get(trackId) as
      { rootPath: string; relPath: string } | undefined
    return row ? toAbsPath(row.rootPath, row.relPath) : null
  }
}

function toTrack(row: TrackRow): Track {
  return {
    id: row.id,
    rootId: row.rootId,
    // Never NULL in practice — `writeTrack` always supplies a title — but the
    // column permits it, and a row written by an older build might not have.
    title: row.title ?? '',
    artist: row.artist,
    album: row.album,
    albumArtist: row.albumArtist,
    trackNo: row.trackNo,
    discNo: row.discNo,
    year: row.year,
    durationSec: row.durationMs === null ? null : row.durationMs / 1000,
    codec: row.codec,
    encodedBytes: row.encodedBytes,
    sampleRateHz: row.sampleRate,
    channels: row.channels,
    bitDepth: row.bitDepth
  }
}
