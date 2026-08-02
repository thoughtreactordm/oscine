import type Database from 'better-sqlite3'
import type {
  AlbumFacet,
  ArtistFacet,
  GetTracksByIdsQuery,
  LibraryBrowseFilters,
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
  Track,
  TrackAudioMetadata,
  TrackGroup,
  TrackSortColumn
} from '@shared/library'
import { artworkUrl } from '@shared/ipc'
import type { RelatedAlbum } from '@shared/related'
import { relateRoots, toAbsPath, type RootRelation } from '../db/paths'
import type { TrackTags } from './metadata'
import type { RelatedQueries, RelatedSeed } from './related'
import { fileStem, type AudioFile } from './walk'

/**
 * Every SQL statement the library layer issues. `./playlists` owns the
 * `playlists` and `playlist_entries` tables and issues its own, borrowing only
 * the track projection below so both produce identical display rows.
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

/** The cheap on-disk identity used by incremental reconciliation. */
export interface StoredTrackFile {
  id: number
  relPath: string
  mtime: number
  size: number
}

export interface ArtworkAlbum {
  albumId: number
  artworkHash: string | null
  tracks: Array<{ trackId: number; absPath: string }>
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
  /**
   * Ascending whichever way the column is sorted.
   *
   * Only a tiebreaker uses this. Reversing the Album column should reverse the
   * albums, not play each one backwards, so the disc/track keys that order
   * within an album hold their direction while `al.title` flips.
   */
  readonly fixed?: boolean
}

/**
 * Disc before track, so a multi-disc album reads in playing order rather than
 * interleaving disc 2's track 1 with disc 1's. Single-disc albums tag no disc
 * at all, hence the COALESCE rather than a nulls-last prefix.
 */
const PLAYING_ORDER: readonly SortKey[] = [
  { expr: 'COALESCE(t.disc_no, 1)', notNull: true },
  { expr: 't.track_no' }
]

const SORT_KEYS: Record<TrackSortColumn, readonly SortKey[]> = {
  trackNo: PLAYING_ORDER,
  title: [{ expr: 't.title', text: true }],
  artist: [{ expr: 'ar.name', text: true }],
  // An album is only meaningful read in playing order: grouping by title alone
  // leaves `t.id` — scan order, which is the directory listing — deciding what
  // follows what, and a discography comes out alphabetised by song title.
  //
  // `t.album_id` rather than `al.id` because the joined-sort query shape has no
  // `al` alias, and rather than nothing at all because `albums` is unique on
  // (title, album_artist): two artists with a "Greatest Hits" share a title, and
  // without this their tracks interleave by disc and track number. Runs have to
  // be contiguous for `listTrackGroups` to describe them.
  album: [
    { expr: 'al.title', text: true },
    { expr: 't.album_id', fixed: true },
    ...PLAYING_ORDER.map((key) => ({ ...key, fixed: true }))
  ],
  durationSec: [{ expr: 't.duration_ms' }]
}

/**
 * The album-major ORDER BY, as SQL, without the `t.id` tiebreaker.
 *
 * Exported for `./playlists`, which orders entries by album so the contents
 * pane can draw the same headers the song list does. Exported rather than
 * restated for the reason `TRACK_PROJECTION` is: the runs `listTrackGroups`
 * and `listEntryGroups` describe are contiguous *only* under this exact
 * ordering, so a second copy that drifted by one key would put a header in the
 * middle of an album and nothing would report an error.
 *
 * Ascending only. The pane offers no direction — there is no sortable header
 * over a playlist, because position remains the truth underneath.
 */
export const ALBUM_MAJOR_ORDER = SORT_KEYS.album
  .map((key) => orderByFragment(key, 'ASC'))
  .join(', ')

/**
 * The ORDER BY for a *run* query, which needs only the keys it groups on.
 *
 * The first two keys of `SORT_KEYS.album` and no more: the remaining two order
 * rows *within* an album, and a GROUP BY has collapsed those away. Taken from
 * the same array as `ALBUM_MAJOR_ORDER` so that the runs and the rows they
 * describe cannot disagree about which album comes first.
 */
export function albumRunOrder(direction: 'ASC' | 'DESC'): string {
  return SORT_KEYS.album
    .slice(0, 2)
    .map((key) => orderByFragment(key, direction))
    .join(', ')
}

/**
 * The album-run GROUP BY key, and its projection.
 *
 * The two queries that draw headers share these so that "one row per run"
 * cannot come to mean different things in the library and in a playlist.
 */
export const ALBUM_GROUP_PROJECTION = `
  t.album_id      AS albumId,
  al.title        AS title,
  aa.name         AS albumArtist,
  al.year         AS year,
  al.artwork_hash AS artworkHash
`

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
export const TRACK_JOINS = `
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums  al ON al.id = t.album_id
  LEFT JOIN artists aa ON aa.id = al.album_artist_id
`

/**
 * The Artist browser is an album-artist dimension. A loose track without an
 * album (or legacy data with no album artist) falls back to its performer.
 */
const BROWSE_ARTIST_ID = 'COALESCE(al.album_artist_id, t.artist_id)' as const

/**
 * Exported alongside `TRACK_JOINS` and `toTrack` so `./playlists` can widen a
 * page of entries into the *same* display rows the track list produces. Three
 * columns copied into a second module is three columns that stop matching, and
 * the symptom would be a playlist showing no artwork after someone adds a
 * field here.
 */
export const TRACK_PROJECTION = `
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
  t.bit_depth    AS bitDepth,
  al.artwork_hash AS artworkHash,
  t.rg_track_gain AS rgTrackGain,
  t.rg_track_peak AS rgTrackPeak,
  t.rg_album_gain AS rgAlbumGain,
  t.rg_album_peak AS rgAlbumPeak,
  t.rg_source     AS rgSource
`

export interface TrackRow {
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
  artworkHash: string | null
  rgTrackGain: number | null
  rgTrackPeak: number | null
  rgAlbumGain: number | null
  rgAlbumPeak: number | null
  rgSource: 'tag' | 'computed' | null
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
    listTrackFiles: db.prepare(`
      SELECT id, rel_path AS relPath, mtime, size
      FROM tracks
      WHERE root_id = ?
    `),
    deleteTrack: db.prepare('DELETE FROM tracks WHERE root_id = ? AND rel_path = ?'),
    findTrackAlbum: db.prepare(
      'SELECT album_id AS albumId FROM tracks WHERE root_id = ? AND rel_path = ?'
    ),

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
    setAlbumArtwork: db.prepare('UPDATE albums SET artwork_hash = ? WHERE id = ?'),
    listReferencedArtworkHashes: db.prepare(`
      SELECT DISTINCT al.artwork_hash AS artworkHash
      FROM albums al
      WHERE al.artwork_hash IS NOT NULL
        AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)
      UNION
      SELECT DISTINCT p.artwork_hash AS artworkHash
      FROM podcasts p
      WHERE p.artwork_hash IS NOT NULL
    `),
    listAlbumsUnderDirectory: db.prepare(`
      SELECT DISTINCT t.album_id AS albumId
      FROM tracks t
      WHERE t.root_id = @rootId
        AND t.album_id IS NOT NULL
        AND (@directory = '' OR substr(t.rel_path, 1, length(@prefix)) = @prefix)
    `),

    upsertTrack: db.prepare(`
      INSERT INTO tracks (
        root_id, rel_path, mtime, size, duration_ms, codec, sample_rate, channels,
        bit_depth, title, artist_id, album_id, track_no, disc_no, genre,
        rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, rg_source
      ) VALUES (
        @rootId, @relPath, @mtime, @size, @durationMs, @codec, @sampleRate, @channels,
        @bitDepth, @title, @artistId, @albumId, @trackNo, @discNo, @genre,
        @rgTrackGain, @rgTrackPeak, @rgAlbumGain, @rgAlbumPeak, @rgSource
      )
      ON CONFLICT(root_id, rel_path) DO UPDATE SET
        mtime = excluded.mtime, size = excluded.size, duration_ms = excluded.duration_ms,
        codec = excluded.codec, sample_rate = excluded.sample_rate,
        channels = excluded.channels, bit_depth = excluded.bit_depth,
        title = excluded.title, artist_id = excluded.artist_id,
        album_id = excluded.album_id, track_no = excluded.track_no,
        disc_no = excluded.disc_no, genre = excluded.genre,
        rg_track_gain = CASE
          WHEN excluded.rg_source IS NULL AND tracks.rg_source = 'computed'
            THEN tracks.rg_track_gain
          ELSE excluded.rg_track_gain
        END,
        rg_track_peak = CASE
          WHEN excluded.rg_source IS NULL AND tracks.rg_source = 'computed'
            THEN tracks.rg_track_peak
          ELSE excluded.rg_track_peak
        END,
        rg_album_gain = CASE
          WHEN excluded.rg_source IS NULL AND tracks.rg_source = 'computed'
            THEN tracks.rg_album_gain
          ELSE excluded.rg_album_gain
        END,
        rg_album_peak = CASE
          WHEN excluded.rg_source IS NULL AND tracks.rg_source = 'computed'
            THEN tracks.rg_album_peak
          ELSE excluded.rg_album_peak
        END,
        rg_source = CASE
          WHEN excluded.rg_source IS NULL AND tracks.rg_source = 'computed'
            THEN tracks.rg_source
          ELSE excluded.rg_source
        END
      RETURNING id
    `),

    resolveTrack: db.prepare(`
      SELECT r.path AS rootPath, t.rel_path AS relPath
      FROM tracks t
      JOIN roots r ON r.id = t.root_id
      WHERE t.id = ?
    `),
    trackAudioMetadata: db.prepare(`
      SELECT t.duration_ms AS durationMs,
             t.size        AS encodedBytes,
             t.channels    AS channels,
             t.rg_track_gain AS rgTrackGain,
             t.rg_track_peak AS rgTrackPeak,
             t.rg_album_gain AS rgAlbumGain,
             t.rg_album_peak AS rgAlbumPeak,
             t.rg_source     AS rgSource
      FROM tracks t
      WHERE t.id = ?
    `),
    // Widens a page of already-chosen ids. Taking the ids as one JSON array
    // rather than an IN-list of placeholders keeps this a single prepared
    // statement whatever the page size — a placeholder list re-compiles on every
    // distinct length, which for a virtualized list is most of them.
    hydrateTracks: db.prepare(`
      SELECT ${TRACK_PROJECTION}
      FROM json_each(@ids) page
      JOIN tracks t ON t.id = page.value
      ${TRACK_JOINS}
    `),

    // ---- W7-5, the related pane ------------------------------------------
    //
    // Every strand below takes its own `@limit` and none of them joins to a
    // browse filter. That is deliberate: relatedness is a property of the seed
    // track, not of whatever the operator happens to have typed in the search
    // box, and a pane that quietly hid an artist's other albums because a
    // filter was active would be answering a question nobody asked.

    /** Everything the strands need about the seed, in one lookup. */
    relatedSeed: db.prepare(`
      SELECT t.id            AS trackId,
             t.root_id       AS rootId,
             t.rel_path      AS relPath,
             t.album_id      AS albumId,
             t.artist_id     AS artistId,
             t.genre         AS genre,
             al.album_artist_id AS albumArtistId,
             al.title        AS albumTitle,
             al.year         AS year,
             ar.name         AS artistName,
             aa.name         AS albumArtistName
      FROM tracks t
      ${TRACK_JOINS}
      WHERE t.id = @trackId
    `),

    /**
     * The rest of the seed's album, in playing order.
     *
     * Disc before track before title, so a multi-disc album reads the way it is
     * pressed rather than interleaved. `NULLS LAST` is spelled as the `IS NULL`
     * sort key because SQLite orders NULL first by default and an untagged
     * track would otherwise head the album.
     */
    relatedAlbumTracks: db.prepare(`
      SELECT ${TRACK_PROJECTION}
      FROM tracks t
      ${TRACK_JOINS}
      WHERE t.album_id = @albumId AND t.id <> @trackId
      ORDER BY t.disc_no IS NULL, t.disc_no,
               t.track_no IS NULL, t.track_no,
               t.title
      LIMIT @limit
    `),

    /** The discography: albums credited to the seed's album artist. */
    relatedArtistAlbums: db.prepare(`
      SELECT al.id      AS albumId,
             al.title   AS title,
             aa.name    AS artist,
             al.year    AS year,
             COUNT(t.id) AS trackCount
      FROM albums al
      LEFT JOIN artists aa ON aa.id = al.album_artist_id
      JOIN tracks t ON t.album_id = al.id
      WHERE al.album_artist_id = @artistId AND al.id IS NOT @albumId
      GROUP BY al.id
      ORDER BY al.year IS NULL, al.year, al.title
      LIMIT @limit
    `),

    /**
     * Compilations: albums the artist plays on without being credited for.
     *
     * `album_artist_id IS NOT @artistId` is the whole definition, and it is why
     * this is a separate strand rather than more rows on the discography — an
     * album where the artist *is* the album artist is their record, and one
     * where they are a track artist on someone else's record is an appearance.
     * `IS NOT` rather than `<>` because an album with no album artist at all
     * would drop out of a comparison against NULL.
     *
     * Served by `idx_tracks_artist_album`, which already existed.
     */
    relatedCompilations: db.prepare(`
      SELECT al.id      AS albumId,
             al.title   AS title,
             aa.name    AS artist,
             al.year    AS year,
             COUNT(t.id) AS trackCount
      FROM albums al
      LEFT JOIN artists aa ON aa.id = al.album_artist_id
      JOIN tracks t ON t.album_id = al.id
      WHERE al.id IN (
              SELECT t2.album_id
              FROM tracks t2
              WHERE t2.artist_id = @artistId AND t2.album_id IS NOT NULL
              GROUP BY t2.album_id
              LIMIT @limit
            )
        AND al.album_artist_id IS NOT @artistId
        AND al.id IS NOT @albumId
      GROUP BY al.id
      ORDER BY al.year IS NULL, al.year, al.title
      LIMIT @limit
    `),

    /**
     * The genre neighbourhood.
     *
     * The inner `GROUP BY ... LIMIT` is load-bearing rather than defensive: a
     * broad genre over a 100k-track library matches tens of thousands of rows,
     * and aggregating all of them to display fifty albums is the difference
     * between a pane that opens within the frame budget and one that does not.
     * `idx_tracks_genre_album` (migration 10) lets SQLite satisfy the grouping
     * from the index in order and stop as soon as the limit is met.
     *
     * Newest first here, unlike the discography: a genre is a browsing surface
     * rather than a body of work, and chronological order from 1954 is not what
     * anyone wants to read first.
     */
    relatedSameGenre: db.prepare(`
      SELECT al.id      AS albumId,
             al.title   AS title,
             aa.name    AS artist,
             al.year    AS year,
             COUNT(t.id) AS trackCount
      FROM albums al
      LEFT JOIN artists aa ON aa.id = al.album_artist_id
      JOIN tracks t ON t.album_id = al.id
      WHERE al.id IN (
              SELECT album_id
              FROM tracks
              WHERE genre = @genre AND album_id IS NOT NULL AND album_id IS NOT @albumId
              GROUP BY album_id
              LIMIT @limit
            )
      GROUP BY al.id
      ORDER BY al.year IS NULL, al.year DESC, al.title
      LIMIT @limit
    `),

    /** The year neighbourhood. Straight off `idx_albums_year`. */
    relatedSameYear: db.prepare(`
      SELECT al.id      AS albumId,
             al.title   AS title,
             aa.name    AS artist,
             al.year    AS year,
             COUNT(t.id) AS trackCount
      FROM albums al
      LEFT JOIN artists aa ON aa.id = al.album_artist_id
      JOIN tracks t ON t.album_id = al.id
      WHERE al.year = @year AND al.id IS NOT @albumId
      GROUP BY al.id
      ORDER BY al.title
      LIMIT @limit
    `),

    /**
     * The folder neighbourhood: albums sitting under the seed's parent folder.
     *
     * A half-open range over `rel_path` rather than the `substr(...)` prefix
     * test `listAlbumsUnderDirectory` uses. Both are correct; only this one is
     * sargable, and the difference matters because this runs on every track
     * change while that runs once per artwork reconciliation. `@prefixEnd` is
     * the prefix with its final byte incremented, so the range covers exactly
     * the subtree — see `folderNeighbourhood` for how it is derived and why
     * paths are safe to compare as bytes here.
     */
    relatedSameFolder: db.prepare(`
      SELECT al.id      AS albumId,
             al.title   AS title,
             aa.name    AS artist,
             al.year    AS year,
             COUNT(t.id) AS trackCount
      FROM albums al
      LEFT JOIN artists aa ON aa.id = al.album_artist_id
      JOIN tracks t ON t.album_id = al.id
      WHERE al.id IN (
              SELECT album_id
              FROM tracks
              WHERE root_id = @rootId
                AND rel_path >= @prefix AND rel_path < @prefixEnd
                AND album_id IS NOT NULL AND album_id IS NOT @albumId
              GROUP BY album_id
              LIMIT @limit
            )
      GROUP BY al.id
      ORDER BY al.year IS NULL, al.year, al.title
      LIMIT @limit
    `)
  }
}

/**
 * The ORDER BY that defines the track list.
 *
 * Nulls last in both directions: an untagged artist belongs at the bottom of
 * the list whichever way it is sorted, and SQLite's default puts NULL first
 * ascending. `t.id` is the tiebreaker — without a total order, two rows that
 * compare equal can swap between pages and a virtualized list shows one row
 * twice while skipping another.
 *
 * A free function because three query shapes need the identical clause. Any of
 * them growing its own copy is how a Shift-range selection ends up one row out
 * from the rows on screen.
 */
function orderByFragment(key: SortKey, direction: 'ASC' | 'DESC'): string {
  const nullsLast = key.notNull ? '' : `${key.expr} IS NULL ASC, `
  const collate = key.text ? ' COLLATE NOCASE' : ''
  return `${nullsLast}${key.expr}${collate} ${key.fixed ? 'ASC' : direction}`
}

function orderByClause(keys: readonly SortKey[], direction: 'ASC' | 'DESC'): string {
  const ordered = keys.map((key) => orderByFragment(key, direction)).join(', ')
  return `${ordered}, t.id ASC`
}

/**
 * The tiebreakers after a joined sort's own column, as SQL.
 *
 * `listTrackIdsByJoinedSort` cannot call `orderByClause`: its leading term is
 * the aliased dimension column rather than the key's own expression, and its
 * nulls-last half is a separate query instead of a prefix. It still has to
 * agree with `orderByClause` to the row, so it takes the remaining keys from
 * the same table rather than restating them.
 */
function joinedTiebreakers(keys: readonly SortKey[], direction: 'ASC' | 'DESC'): string {
  return keys
    .slice(1)
    .map((key) => `${orderByFragment(key, direction)}, `)
    .join('')
}

function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map((row) => row.id)
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

  listTrackFiles(rootId: number): StoredTrackFile[] {
    return this.statements.listTrackFiles.all(rootId) as StoredTrackFile[]
  }

  /**
   * Deletes a set of vanished logical files atomically.
   *
   * The schema's track-delete triggers remove the corresponding FTS rows in
   * this same transaction, so a watcher deletion cannot leave stale search
   * results behind.
   */
  deleteTracks(rootId: number, relPaths: readonly string[]): Set<number> {
    const albumIds = new Set<number>()
    if (relPaths.length === 0) return albumIds

    this.db.transaction((paths: readonly string[]) => {
      for (const relPath of paths) {
        const previous = this.statements.findTrackAlbum.get(rootId, relPath) as
          { albumId: number | null } | undefined
        if (previous?.albumId !== null && previous?.albumId !== undefined) {
          albumIds.add(previous.albumId)
        }
        this.statements.deleteTrack.run(rootId, relPath)
      }
    })(relPaths)
    return albumIds
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
  writeTracks(rootId: number, entries: readonly ScannedTrack[]): Set<number> {
    const albumIds = new Set<number>()
    if (entries.length === 0) return albumIds

    const write = this.db.transaction((items: readonly ScannedTrack[]) => {
      for (const item of items) {
        for (const albumId of this.writeTrack(rootId, item)) albumIds.add(albumId)
      }
    })

    try {
      write(entries)
    } catch (error) {
      this.artistIds.clear()
      this.albumIds.clear()
      throw error
    }
    return albumIds
  }

  private writeTrack(rootId: number, { file, tags }: ScannedTrack): Set<number> {
    const affected = new Set<number>()
    const previous = this.statements.findTrackAlbum.get(rootId, file.relPath) as
      { albumId: number | null } | undefined
    if (previous?.albumId !== null && previous?.albumId !== undefined) {
      affected.add(previous.albumId)
    }
    const artistId = tags.artist === null ? null : this.upsertArtist(tags.artist)

    // The card's compilation rule. Without the fallback, an album whose tracks
    // carry no ALBUMARTIST resolves to album_artist_id NULL for every track —
    // and because NULLs do not collide in a UNIQUE constraint, the album
    // shatters into one row per track.
    const albumArtistId = tags.albumArtist === null ? artistId : this.upsertArtist(tags.albumArtist)

    const albumId =
      tags.album === null ? null : this.upsertAlbum(tags.album, albumArtistId, tags.year)
    if (albumId !== null) affected.add(albumId)

    // Foobar's behaviour, and the reason `Track.title` is non-nullable across
    // IPC: a file with no title tag shows its filename rather than a blank row.
    // The correction path for a wrong title is `track_overrides` (D7), not this.
    const title = tags.title ?? fileStem(file.relPath)

    const gain = tags.replayGain
    this.statements.upsertTrack.get({
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
      genre: tags.genre,
      rgTrackGain: gain?.trackGainDb ?? null,
      rgTrackPeak: gain?.trackPeak ?? null,
      rgAlbumGain: gain?.albumGainDb ?? null,
      rgAlbumPeak: gain?.albumPeak ?? null,
      rgSource: gain === null ? null : 'tag'
    })

    // Migration 4's metadata triggers update FTS in the same transaction as
    // this row. Keeping it in SQL also covers direct deletes and root cascades.
    return affected
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
    const { ids, total } = this.listTrackIds(query)
    return { tracks: this.hydrateTracks(ids), total }
  }

  /**
   * The same window as `listTracks`, resolved to ids without the display
   * projection.
   *
   * This is the ordering authority, and `listTracks` is deliberately built on
   * top of it rather than beside it. The renderer resolves a Shift-range that
   * crosses unloaded pages through this call, so the two results must agree
   * about which row sits at which offset; two ORDER BY clauses that merely
   * looked alike would drift, and the symptom would be a range selection
   * silently off by a row somewhere past the end of what is on screen.
   *
   * Ids also let a large range be resolved without mounting or retaining a
   * single `Track` — the reason the page ceiling here is ten times the row one.
   */
  listTrackIds(query: ListTrackIdsQuery): ListTrackIdsResult {
    const keys = SORT_KEYS[query.sort]
    if (!keys) throw new Error(`Unsupported sort column: ${String(query.sort)}`)
    const direction = query.direction === 'desc' ? 'DESC' : 'ASC'
    const filtered =
      query.artistIds !== undefined ||
      query.albumIds !== undefined ||
      query.searchText !== undefined
    if (filtered) return this.listFilteredTrackIds(query, keys, direction)

    const where = query.rootId === undefined ? '' : 'WHERE t.root_id = @rootId'
    const params = { rootId: query.rootId ?? null, limit: query.limit, offset: query.offset }

    const { total } = this.db
      .prepare(`SELECT count(*) AS total FROM tracks t ${where}`)
      .get(params) as { total: number }

    const joinedSort = JOINED_SORTS[query.sort]
    if (joinedSort) {
      return { ids: this.listTrackIdsByJoinedSort(query, joinedSort, direction), total }
    }

    const rows = this.db
      .prepare(
        `SELECT t.id AS id
         FROM tracks t
         ${where}
         ORDER BY ${orderByClause(keys, direction)}
         LIMIT @limit OFFSET @offset`
      )
      .all(params)

    return { ids: idsOf(rows), total }
  }

  /**
   * Orders an arbitrary id set the way the track list would.
   *
   * The renderer's selection is a set of ids, which has no inherent order; this
   * is how a consumer gets those tracks back in list order without scraping
   * rendered rows or holding a position for every one of them.
   *
   * Two properties are contractual. Browse filters are not accepted, because a
   * selection outlives the search that was active when it was made and
   * filtering here would drop exactly the rows that promise keeps. And ids no
   * longer in the library are omitted rather than reported — a caller about to
   * add tracks to a playlist wants the surviving ones, and the shrunken result
   * is how it learns the rest are gone.
   */
  orderTrackIds(query: OrderTrackIdsQuery): number[] {
    const keys = SORT_KEYS[query.sort]
    if (!keys) throw new Error(`Unsupported sort column: ${String(query.sort)}`)
    const unique = [...new Set(query.ids)]
    if (unique.length === 0) return []

    const direction = query.direction === 'desc' ? 'DESC' : 'ASC'
    const rows = this.db
      .prepare(
        `SELECT t.id AS id
         FROM json_each(@ids) page
         JOIN tracks t ON t.id = page.value
         ${TRACK_JOINS}
         ORDER BY ${orderByClause(keys, direction)}`
      )
      .all({ ids: JSON.stringify(unique) })

    return idsOf(rows)
  }

  /**
   * Display rows for an id list the caller already ordered.
   *
   * The public face of `hydrateTracks`, which every paged read here already
   * goes through — so an explicit id list costs the same wide projection as a
   * page of the list does, and drops deleted ids the same way.
   */
  getTracksByIds(query: GetTracksByIdsQuery): Track[] {
    return this.hydrateTracks(query.ids)
  }

  /**
   * Widens a chosen page of ids into display rows, preserving the given order.
   *
   * Reapplying the order in JS rather than asking SQLite for it a second time is
   * not a micro-optimisation: the wide projection reaches through three
   * dimension joins, and re-deriving the sort keys across them was the
   * expensive half of the query this replaced. The ids are already in order, so
   * a lookup table is all that is needed.
   */
  private hydrateTracks(ids: readonly number[]): Track[] {
    if (ids.length === 0) return []
    const rows = this.statements.hydrateTracks.all({ ids: JSON.stringify(ids) }) as TrackRow[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    // A track deleted between the two queries drops out rather than arriving as
    // a hole the renderer would have to recognise.
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is TrackRow => row !== undefined)
      .map(toTrack)
  }

  /**
   * The related pane's six strands, as data access and nothing else.
   *
   * Handed out as an interface rather than composed here because the composition
   * — which strands to run, in what order, and which of them a better
   * implementation may replace — is W7-5's seam and lives in `./related`. That
   * module is then testable against a hand-written `RelatedQueries` with no
   * database at all, which is the whole reason the split is worth a method.
   */
  relatedQueries(): RelatedQueries {
    const s = this.statements
    return {
      seed: (trackId) => (s.relatedSeed.get({ trackId }) as RelatedSeed | undefined) ?? null,
      albumTracks: ({ albumId, trackId, limit }) =>
        (s.relatedAlbumTracks.all({ albumId, trackId, limit }) as TrackRow[]).map(toTrack),
      artistAlbums: ({ artistId, albumId, limit }) =>
        s.relatedArtistAlbums.all({ artistId, albumId, limit }) as RelatedAlbum[],
      compilations: ({ artistId, albumId, limit }) =>
        s.relatedCompilations.all({ artistId, albumId, limit }) as RelatedAlbum[],
      sameGenre: ({ genre, albumId, limit }) =>
        s.relatedSameGenre.all({ genre, albumId, limit }) as RelatedAlbum[],
      sameYear: ({ year, albumId, limit }) =>
        s.relatedSameYear.all({ year, albumId, limit }) as RelatedAlbum[],
      sameFolder: ({ rootId, prefix, prefixEnd, albumId, limit }) =>
        s.relatedSameFolder.all({ rootId, prefix, prefixEnd, albumId, limit }) as RelatedAlbum[]
    }
  }

  listArtists(query: ListFacetsQuery): ListArtistsResult {
    const filter = buildFilter(query)
    const params = { ...filter.params, limit: query.limit, offset: query.offset }
    const rows = this.db
      .prepare(
        `SELECT browse_artist.id AS id,
                browse_artist.name AS name,
                count(*) AS trackCount,
                count(*) OVER () AS facetTotal
         FROM tracks t
         ${filter.ftsJoin}
         LEFT JOIN albums al ON al.id = t.album_id
         JOIN artists browse_artist ON browse_artist.id = ${BROWSE_ARTIST_ID}
         ${filter.where}
         GROUP BY browse_artist.id
         ORDER BY browse_artist.name COLLATE NOCASE ASC, browse_artist.id ASC
         LIMIT @limit OFFSET @offset`
      )
      .all(params) as Array<ArtistFacet & { facetTotal: number }>

    const total = rows[0]?.facetTotal ?? facetTotal(this.db, BROWSE_ARTIST_ID, filter, params)
    return {
      artists: rows.map(({ facetTotal: _, ...artist }) => artist),
      total
    }
  }

  listAlbums(query: ListFacetsQuery): ListAlbumsResult {
    const filter = buildFilter(query)
    const params = { ...filter.params, limit: query.limit, offset: query.offset }
    const total = facetTotal(this.db, 't.album_id', filter, params)
    const rows = this.db
      .prepare(
        `SELECT al.id AS id,
                al.title AS title,
                aa.name AS albumArtist,
                al.year AS year,
                al.artwork_hash AS artworkHash,
                count(*) AS trackCount
         FROM tracks t
         ${filter.ftsJoin}
         JOIN albums al ON al.id = t.album_id
         LEFT JOIN artists aa ON aa.id = al.album_artist_id
         ${filter.where}
         GROUP BY al.id
         ORDER BY al.title COLLATE NOCASE ASC, al.id ASC
         LIMIT @limit OFFSET @offset`
      )
      .all(params) as Array<Omit<AlbumFacet, 'artwork'> & { artworkHash: string | null }>

    return {
      albums: rows.map(({ artworkHash, ...album }) => ({
        ...album,
        artwork: artworkUrls(artworkHash)
      })),
      total
    }
  }

  /**
   * The artist facet window, resolved to ids.
   *
   * The projection is narrower than `listArtists` but the FROM, the GROUP BY and
   * above all the ORDER BY are the same clause, because a Shift-range in the
   * pane is expressed in index positions: the ids at positions 40 to 900 have to
   * be the ids the user would have seen there. Two ORDER BY clauses that merely
   * looked alike would drift, and the symptom would be a range selection
   * silently off by a row somewhere past what is on screen.
   */
  listArtistIds(query: ListFacetIdsQuery): ListFacetIdsResult {
    const filter = buildFilter(query)
    const params = { ...filter.params, limit: query.limit, offset: query.offset }
    const rows = this.db
      .prepare(
        `SELECT browse_artist.id AS id,
                count(*) OVER () AS facetTotal
         FROM tracks t
         ${filter.ftsJoin}
         LEFT JOIN albums al ON al.id = t.album_id
         JOIN artists browse_artist ON browse_artist.id = ${BROWSE_ARTIST_ID}
         ${filter.where}
         GROUP BY browse_artist.id
         ORDER BY browse_artist.name COLLATE NOCASE ASC, browse_artist.id ASC
         LIMIT @limit OFFSET @offset`
      )
      .all(params) as Array<{ id: number; facetTotal: number }>

    return {
      ids: rows.map((row) => row.id),
      total: rows[0]?.facetTotal ?? facetTotal(this.db, BROWSE_ARTIST_ID, filter, params)
    }
  }

  /** The album facet window, resolved to ids. Mirrors `listAlbums` clause for clause. */
  listAlbumIds(query: ListFacetIdsQuery): ListFacetIdsResult {
    const filter = buildFilter(query)
    const params = { ...filter.params, limit: query.limit, offset: query.offset }
    const rows = this.db
      .prepare(
        `SELECT al.id AS id,
                count(*) OVER () AS facetTotal
         FROM tracks t
         ${filter.ftsJoin}
         JOIN albums al ON al.id = t.album_id
         ${filter.where}
         GROUP BY al.id
         ORDER BY al.title COLLATE NOCASE ASC, al.id ASC
         LIMIT @limit OFFSET @offset`
      )
      .all(params) as Array<{ id: number; facetTotal: number }>

    return {
      ids: rows.map((row) => row.id),
      total: rows[0]?.facetTotal ?? facetTotal(this.db, 't.album_id', filter, params)
    }
  }

  /**
   * The album runs the track list falls into, under the same predicate.
   *
   * Album-major orderings only. Under `title` the albums interleave, so there
   * are no runs to describe and a caller asking for them has misunderstood the
   * list it is about to draw; that is a programming error rather than an empty
   * result, hence the throw.
   *
   * The ORDER BY is the album-level prefix of `SORT_KEYS.album` rather than a
   * restatement of it. The runs and the rows have to agree on which album comes
   * first and, thanks to the `t.album_id` tiebreaker, on the fact that each one
   * is contiguous — a header placed against a run that the rows do not actually
   * form would put every subsequent row under the wrong album.
   */
  listTrackGroups(query: ListTrackGroupsQuery): ListTrackGroupsResult {
    if (query.sort !== 'album') {
      throw new Error(`Track groups are album-major only; got sort: ${String(query.sort)}`)
    }
    const direction = query.direction === 'desc' ? 'DESC' : 'ASC'
    const filter = buildFilter(query)

    const rows = this.db
      .prepare(
        `SELECT ${ALBUM_GROUP_PROJECTION},
                count(*) AS trackCount
         FROM tracks t
         ${filter.ftsJoin}
         ${TRACK_JOINS}
         ${filter.where}
         GROUP BY t.album_id
         ORDER BY ${albumRunOrder(direction)}`
      )
      .all(filter.params) as Array<Omit<TrackGroup, 'artwork'> & { artworkHash: string | null }>

    let total = 0
    const groups = rows.map(({ artworkHash, ...group }) => {
      total += group.trackCount
      return { ...group, artwork: artworkUrls(artworkHash) }
    })

    return { groups, total }
  }

  getTrackAudioMetadata(trackId: number): TrackAudioMetadata | null {
    const row = this.statements.trackAudioMetadata.get(trackId) as
      | {
          durationMs: number | null
          encodedBytes: number
          channels: number | null
          rgTrackGain: number | null
          rgTrackPeak: number | null
          rgAlbumGain: number | null
          rgAlbumPeak: number | null
          rgSource: 'tag' | 'computed' | null
        }
      | undefined
    if (!row) return null
    return {
      durationSec: row.durationMs === null ? null : row.durationMs / 1000,
      encodedBytes: row.encodedBytes,
      channels: row.channels,
      rgTrackGainDb: row.rgTrackGain,
      rgTrackPeak: row.rgTrackPeak,
      rgAlbumGainDb: row.rgAlbumGain,
      rgAlbumPeak: row.rgAlbumPeak,
      rgSource: row.rgSource
    }
  }

  /**
   * Reads an artist/album page without sorting the whole track table.
   *
   * The dimension table supplies non-null rows in indexed order. Null rows are
   * a separate id-ordered tail, which exactly matches listTracks' nulls-last
   * contract. Splitting the query also makes a page that crosses that boundary
   * cheap instead of forcing a compound-query sort.
   */
  private listTrackIdsByJoinedSort(
    query: ListTrackIdsQuery,
    sort: JoinedSort,
    direction: 'ASC' | 'DESC'
  ): number[] {
    const rootPredicate = query.rootId === undefined ? '' : 'AND t.root_id = @rootId'
    const tiebreakers = joinedTiebreakers(SORT_KEYS[query.sort], direction)
    const params = { rootId: query.rootId ?? null, limit: query.limit, offset: query.offset }
    const { total: taggedTotal } = this.db
      .prepare(
        `SELECT count(*) AS total
         FROM tracks t
         WHERE t.${sort.foreignKey} IS NOT NULL
         ${rootPredicate}`
      )
      .get(params) as { total: number }

    const ids: number[] = []
    const taggedAvailable = Math.max(0, taggedTotal - query.offset)
    const taggedLimit = Math.min(query.limit, taggedAvailable)

    if (taggedLimit > 0) {
      ids.push(
        ...idsOf(
          this.db
            .prepare(
              `SELECT t.id AS id
               FROM ${sort.table} ${sort.alias} INDEXED BY ${sort.index}
               JOIN tracks t INDEXED BY ${sort.trackIndex}
                 ON t.${sort.foreignKey} = ${sort.alias}.id
               WHERE 1 = 1
               ${rootPredicate}
               ORDER BY ${sort.value} COLLATE NOCASE ${direction}, ${tiebreakers}t.id ASC
               LIMIT @limit OFFSET @offset`
            )
            .all({ ...params, limit: taggedLimit })
        )
      )
    }

    const nullLimit = query.limit - ids.length
    if (nullLimit > 0) {
      const nullOffset = Math.max(0, query.offset - taggedTotal)
      ids.push(
        ...idsOf(
          this.db
            .prepare(
              `SELECT t.id AS id
               FROM tracks t
               WHERE t.${sort.foreignKey} IS NULL
               ${rootPredicate}
               ORDER BY ${tiebreakers}t.id ASC
               LIMIT @limit OFFSET @offset`
            )
            .all({ ...params, limit: nullLimit, offset: nullOffset })
        )
      )
    }

    return ids
  }

  /**
   * Filtered browse/search shape.
   *
   * FTS and dimension predicates first reduce the candidate ids. Only that
   * bounded set is ordered and windowed; the wide display projection happens
   * after the page has been chosen.
   */
  private listFilteredTrackIds(
    query: ListTrackIdsQuery,
    keys: readonly SortKey[],
    direction: 'ASC' | 'DESC'
  ): ListTrackIdsResult {
    const filter = buildFilter(query)
    const params = { ...filter.params, limit: query.limit, offset: query.offset }
    const { total } = this.db
      .prepare(
        `SELECT count(*) AS total
         FROM tracks t
         ${filter.ftsJoin}
         LEFT JOIN albums al ON al.id = t.album_id
         ${filter.where}`
      )
      .get(params) as { total: number }

    const rows = this.db
      .prepare(
        `SELECT t.id AS id
         FROM tracks t
         ${filter.ftsJoin}
         ${TRACK_JOINS}
         ${filter.where}
         ORDER BY ${orderByClause(keys, direction)}
         LIMIT @limit OFFSET @offset`
      )
      .all(params)

    return { ids: idsOf(rows), total }
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

  /**
   * Candidate tracks are ordered by stored root id and POSIX relative path.
   * Reconciliation uses this order for embedded and folder-art discovery.
   */
  listArtworkAlbums(albumIds?: readonly number[]): ArtworkAlbum[] {
    if (albumIds?.length === 0) return []
    const filter =
      albumIds && albumIds.length <= 500
        ? `WHERE al.id IN (${albumIds.map(() => '?').join(', ')})`
        : ''
    const params = filter === '' ? [] : [...albumIds!]
    const rows = this.db
      .prepare(
        `SELECT al.id AS albumId,
                al.artwork_hash AS artworkHash,
                t.id AS trackId,
                r.path AS rootPath,
                t.rel_path AS relPath
         FROM albums al
         JOIN tracks t ON t.album_id = al.id
         JOIN roots r ON r.id = t.root_id
         ${filter}
         ORDER BY al.id ASC, t.root_id ASC, t.rel_path COLLATE BINARY ASC, t.id ASC`
      )
      .all(...params) as Array<{
      albumId: number
      artworkHash: string | null
      trackId: number
      rootPath: string
      relPath: string
    }>

    const wanted = albumIds && filter === '' ? new Set(albumIds) : null
    const albums = new Map<number, ArtworkAlbum>()
    for (const row of rows) {
      if (wanted && !wanted.has(row.albumId)) continue
      const absPath = toAbsPath(row.rootPath, row.relPath)
      if (!absPath) continue
      const album =
        albums.get(row.albumId) ??
        ({
          albumId: row.albumId,
          artworkHash: row.artworkHash,
          tracks: []
        } satisfies ArtworkAlbum)
      album.tracks.push({ trackId: row.trackId, absPath })
      albums.set(row.albumId, album)
    }
    return [...albums.values()]
  }

  setAlbumArtwork(albumId: number, artworkHash: string | null): void {
    this.statements.setAlbumArtwork.run(artworkHash, albumId)
  }

  listReferencedArtworkHashes(): Set<string> {
    const rows = this.statements.listReferencedArtworkHashes.all() as Array<{
      artworkHash: string
    }>
    return new Set(rows.map((row) => row.artworkHash))
  }

  /**
   * Albums with tracks in or below a POSIX-relative directory.
   *
   * Folder artwork applies to descendants as well as direct children so an
   * album-level image can cover CD1/CD2 subdirectories.
   */
  listAlbumIdsUnderDirectories(rootId: number, directories: readonly string[]): Set<number> {
    const albumIds = new Set<number>()
    for (const directory of new Set(directories)) {
      const rows = this.statements.listAlbumsUnderDirectory.all({
        rootId,
        directory,
        prefix: `${directory}/`
      }) as Array<{ albumId: number }>
      for (const row of rows) albumIds.add(row.albumId)
    }
    return albumIds
  }
}

interface FilterSql {
  readonly ftsJoin: string
  readonly where: string
  readonly params: Record<string, string | number>
}

/**
 * Turns plain user text into ANDed literal FTS5 phrases, never query syntax.
 *
 * Terms shorter than a trigram are ignored when a longer term is present, so
 * natural searches such as "A Night" remain indexed rather than becoming an
 * impossible one-character MATCH.
 */
function ftsLiteral(text: string): string {
  const terms = text
    .split(/\s+/u)
    .filter((term) => [...term].length >= 3)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
  return terms.join(' AND ')
}

/**
 * Constrains a dimension to a set of ids.
 *
 * The set arrives as a JSON array bound to one parameter and joined through
 * `json_each`, not as generated `@id0, @id1, …` placeholders. Two reasons: the
 * statement text no longer varies with the size of the selection, so SQLite's
 * statement cache holds one plan for every selection rather than one per arity;
 * and the 999-parameter limit stops being a ceiling the selection can reach.
 */
function addIdPredicate(
  predicates: string[],
  params: Record<string, string | number>,
  dimension: string,
  name: 'artistIds' | 'albumIds',
  ids: readonly number[] | undefined
): void {
  if (ids === undefined || ids.length === 0) return
  if (ids.length === 1) {
    predicates.push(`${dimension} = @${name}`)
    params[name] = ids[0] as number
    return
  }
  predicates.push(`${dimension} IN (SELECT value FROM json_each(@${name}))`)
  params[name] = JSON.stringify([...ids])
}

function buildFilter(filters: LibraryBrowseFilters): FilterSql {
  const predicates: string[] = []
  const params: Record<string, string | number> = {}

  if (filters.rootId !== undefined) {
    predicates.push('t.root_id = @rootId')
    params.rootId = filters.rootId
  }
  // A single id still becomes `= @id` rather than a one-element `IN`. SQLite
  // plans the equality against the index directly, and the facet dimensions are
  // the two predicates every browse query in the app carries — the common case
  // of one selected artist should not pay for a table-valued function.
  addIdPredicate(predicates, params, BROWSE_ARTIST_ID, 'artistIds', filters.artistIds)
  addIdPredicate(predicates, params, 't.album_id', 'albumIds', filters.albumIds)
  if (filters.searchText !== undefined) {
    predicates.push('tracks_fts MATCH @search')
    params.search = ftsLiteral(filters.searchText)
  }

  return {
    ftsJoin: filters.searchText === undefined ? '' : 'JOIN tracks_fts ON tracks_fts.rowid = t.id',
    where: predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`,
    params
  }
}

function facetTotal(
  db: Database.Database,
  dimension: typeof BROWSE_ARTIST_ID | 't.album_id',
  filter: FilterSql,
  params: Record<string, string | number>
): number {
  const { total } = db
    .prepare(
      `SELECT count(*) AS total
       FROM (
         SELECT ${dimension}
         FROM tracks t
         ${filter.ftsJoin}
         LEFT JOIN albums al ON al.id = t.album_id
         ${filter.where}
           ${filter.where === '' ? 'WHERE' : 'AND'} ${dimension} IS NOT NULL
         GROUP BY ${dimension}
       ) facets`
    )
    .get(params) as { total: number }
  return total
}

export function toTrack(row: TrackRow): Track {
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
    bitDepth: row.bitDepth,
    artwork: artworkUrls(row.artworkHash),
    rgTrackGainDb: row.rgTrackGain,
    rgTrackPeak: row.rgTrackPeak,
    rgAlbumGainDb: row.rgAlbumGain,
    rgAlbumPeak: row.rgAlbumPeak,
    rgSource: row.rgSource
  }
}

/** Exported alongside `ALBUM_GROUP_PROJECTION`, which selects the hash it takes. */
export function artworkUrls(hash: string | null): Track['artwork'] {
  return {
    small: artworkUrl(hash, 'small'),
    large: artworkUrl(hash, 'large')
  }
}
