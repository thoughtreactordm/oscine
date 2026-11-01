import type Database from 'better-sqlite3'
import type { LibraryCoverageField } from '@shared/library'

/**
 * The library reads behind the agent's structured tools — **W24-4**,
 * `oscine-mcp` → D36.3/D36.4.
 *
 * IPC's list queries are shaped for virtualized panels: a window, a sort, the
 * browse predicate. An agent asks coarser questions ("tracks with no genre from
 * before 1990", "albums whose years disagree") and wants a chosen handful of
 * fields back. This is that query surface. It sits beside `LibraryStore` and is
 * reached through `LibraryService`, so the MCP tools never hold SQL (D36.3).
 *
 * Everything here is a read, and every value is **effective**: a correction in
 * `track_overrides` wins over the file's tag, the way the editor and the browse
 * show it. Paths are a root *name* plus the POSIX path relative to it; the
 * root's absolute path is never selected.
 */

// --- Shared SQL ---------------------------------------------------------------

/**
 * Whether a track's effective album artist is present.
 *
 * The browse cannot tell: a file with no ALBUMARTIST is grouped under its
 * performer, so `albums.album_artist_id` is set either way. Migration 028's
 * `tag_album_artist` records whether the file named one, and a standing
 * correction overrides both — a `''` correction is a deliberate clear. A row
 * not re-read since 028 (NULL) falls back to what the index shows.
 *
 * Aliases: `t` tracks, `o` track_overrides, `aa` the album's artist.
 */
export const ALBUM_ARTIST_PRESENT_SQL = `(CASE
  WHEN o.album_artist_name IS NOT NULL THEN TRIM(o.album_artist_name) <> ''
  WHEN t.tag_album_artist IS NOT NULL THEN t.tag_album_artist = 1
  ELSE NULLIF(TRIM(aa.name), '') IS NOT NULL
END)`

/**
 * Per coverage field, the SQL that is true when the track has an effective
 * value — `library_overview` sums these and `find_tracks` filters on them, so
 * "12 tracks have no genre" and the 12 tracks it finds are the same 12.
 *
 * Aliases: `t`, `o` (track_overrides), `al`, `aa`, `awo` (artwork_overrides).
 */
export const PRESENCE_SQL: Readonly<Record<LibraryCoverageField, string>> = {
  title: `NULLIF(TRIM(t.title), '') IS NOT NULL`,
  artist: `t.artist_id IS NOT NULL`,
  album: `t.album_id IS NOT NULL`,
  albumArtist: ALBUM_ARTIST_PRESENT_SQL,
  trackNo: `t.track_no IS NOT NULL`,
  discNo: `t.disc_no IS NOT NULL`,
  year: `al.year IS NOT NULL`,
  genre: `NULLIF(TRIM(COALESCE(o.genre, t.genre)), '') IS NOT NULL`,
  artwork: `(CASE WHEN awo.track_id IS NOT NULL THEN awo.image_hash ELSE al.artwork_hash END) IS NOT NULL`,
  replayGainTrack: `t.rg_track_gain IS NOT NULL`,
  replayGainAlbum: `t.rg_album_gain IS NOT NULL`,
  userTags: `EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = t.id)`
}

const AGENT_TRACK_JOINS = `
  FROM tracks t
  JOIN roots r ON r.id = t.root_id
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums  al ON al.id = t.album_id
  LEFT JOIN artists aa ON aa.id = al.album_artist_id
  LEFT JOIN track_overrides   o   ON o.track_id   = t.id
  LEFT JOIN artwork_overrides awo ON awo.track_id = t.id
  LEFT JOIN track_favorites   fav ON fav.track_id = t.id
`

// --- Tracks -------------------------------------------------------------------

/** Every field a caller can ask for. `id` is always returned and is not listed. */
export const AGENT_TRACK_FIELDS = [
  'title',
  'artist',
  'album',
  'albumArtist',
  'albumId',
  'artistId',
  'trackNo',
  'discNo',
  'year',
  'genre',
  'durationSec',
  'codec',
  'sampleRateHz',
  'bitDepth',
  'channels',
  'bytes',
  'playCount',
  'lastPlayedAt',
  'favorite',
  'hasCorrections',
  'root',
  'path',
  'userTags'
] as const

export type AgentTrackField = (typeof AGENT_TRACK_FIELDS)[number]

/** Enough display text to talk about a track, and nothing that costs tokens besides. */
export const DEFAULT_AGENT_TRACK_FIELDS: readonly AgentTrackField[] = [
  'title',
  'artist',
  'album',
  'albumArtist',
  'year',
  'durationSec'
]

export type AgentTrackValue = string | number | boolean | string[] | null

export type AgentTrack = { id: number } & Partial<Record<AgentTrackField, AgentTrackValue>>

/** How each field is selected, and how its raw column becomes the wire value. */
const FIELD_SQL: Readonly<Record<AgentTrackField, string>> = {
  title: 't.title',
  artist: 'ar.name',
  album: 'al.title',
  albumArtist: 'aa.name',
  albumId: 't.album_id',
  artistId: 't.artist_id',
  trackNo: 't.track_no',
  discNo: 't.disc_no',
  year: 'al.year',
  genre: `NULLIF(TRIM(COALESCE(o.genre, t.genre)), '')`,
  durationSec: 'ROUND(t.duration_ms / 1000.0, 1)',
  codec: 't.codec',
  sampleRateHz: 't.sample_rate',
  bitDepth: 't.bit_depth',
  channels: 't.channels',
  bytes: 't.size',
  playCount: 't.play_count',
  lastPlayedAt: 't.last_played_at',
  favorite: 'fav.track_id IS NOT NULL',
  hasCorrections: `(o.track_id IS NOT NULL OR awo.track_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM track_tag_overrides tto WHERE tto.track_id = t.id))`,
  root: 'r.label',
  path: 't.rel_path',
  userTags: `(SELECT json_group_array(label) FROM (
    SELECT tg.label FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id
    WHERE tt.track_id = t.id ORDER BY tg.label COLLATE NOCASE))`
}

function fieldValue(field: AgentTrackField, raw: unknown): AgentTrackValue {
  if (raw === null || raw === undefined) return null
  switch (field) {
    case 'favorite':
    case 'hasCorrections':
      return raw === 1
    case 'lastPlayedAt':
      return new Date(raw as number).toISOString()
    case 'userTags':
      return JSON.parse(raw as string) as string[]
    default:
      return raw as string | number
  }
}

/** One text constraint: exact (case-insensitive) or a substring. */
export type TextMatch = { equals: string } | { contains: string }

export interface AgentTrackFilter {
  title?: TextMatch
  artist?: TextMatch
  album?: TextMatch
  albumArtist?: TextMatch
  /** The effective genre string, delimiters and all. */
  genre?: TextMatch
  /** The path relative to its root, POSIX separators. */
  path?: TextMatch
  /** A root's name (its label), case-insensitive. */
  root?: string
  codecs?: readonly string[]
  yearMin?: number
  yearMax?: number
  durationSecMin?: number
  durationSecMax?: number
  playCountMin?: number
  playCountMax?: number
  /** UTC ms, inclusive. */
  lastPlayedFrom?: number
  /** UTC ms, inclusive. */
  lastPlayedTo?: number
  favorite?: boolean
  hasCorrections?: boolean
  /** A user tag's label, case-insensitive. */
  userTag?: string
  albumId?: number
  /** Matches the track's own artist or its album's artist. */
  artistId?: number
  /** Fields that must have an effective value. */
  present?: readonly LibraryCoverageField[]
  /** Fields that must have none. */
  missing?: readonly LibraryCoverageField[]
}

export const AGENT_TRACK_SORTS = ['id', 'mostPlayed', 'recentlyPlayed', 'album'] as const
export type AgentTrackSort = (typeof AGENT_TRACK_SORTS)[number]

const TRACK_ORDER: Readonly<Record<AgentTrackSort, string>> = {
  id: 't.id',
  mostPlayed: 't.play_count DESC, t.id',
  recentlyPlayed: 't.last_played_at DESC NULLS LAST, t.id',
  album: `aa.name COLLATE NOCASE, al.title COLLATE NOCASE, al.id,
          t.disc_no NULLS LAST, t.track_no NULLS LAST, t.id`
}

export interface AgentTrackQuery {
  filter: AgentTrackFilter
  fields: readonly AgentTrackField[]
  sort: AgentTrackSort
  offset: number
  limit: number
}

export interface Page<T> {
  rows: T[]
  /** Rows matching before paging. */
  total: number
}

// --- Albums and artists -------------------------------------------------------

export interface AgentAlbumQuery {
  title?: TextMatch
  albumArtist?: TextMatch
  /** Albums with a track by this artist, or credited to them. */
  artistId?: number
  yearMin?: number
  yearMax?: number
  offset: number
  limit: number
}

export interface AgentAlbum {
  id: number
  title: string
  albumArtist: string | null
  albumArtistId: number | null
  year: number | null
  tracks: number
  durationSec: number
}

export interface AgentArtistQuery {
  name?: TextMatch
  offset: number
  limit: number
}

export interface AgentArtist {
  id: number
  name: string
  /** Tracks performed by this artist. */
  tracks: number
  /** Albums credited to this artist (as album artist). */
  albums: number
}

// --- Issues -------------------------------------------------------------------

export const ISSUE_CHECKS = [
  'missingAlbumArtist',
  'yearMismatch',
  'duplicates',
  'artistVariants'
] as const
export type IssueCheck = (typeof ISSUE_CHECKS)[number]

/** Two copies whose durations differ by more than this are not the same recording. */
export const DUPLICATE_DURATION_TOLERANCE_MS = 2000
/** Ids listed per group; a larger group says how many it holds and can be listed in full by album. */
export const ISSUE_GROUP_ID_CAP = 20

export interface MissingAlbumArtistIssue {
  albumId: number
  album: string
  /** Who the browse groups it under today — usually the first performer. */
  shownUnder: string | null
  tracksMissing: number
  trackIds: number[]
}

export interface YearMismatchIssue {
  albumId: number
  album: string
  albumArtist: string | null
  /** The single year the album shows. */
  shownYear: number | null
  years: { year: number; tracks: number }[]
}

export interface DuplicateIssue {
  artist: string
  title: string
  tracks: {
    id: number
    album: string | null
    durationSec: number | null
    codec: string | null
    root: string
    path: string
  }[]
}

export interface ArtistVariantIssue {
  variants: { artistId: number; name: string; tracks: number }[]
}

export interface IssueGroups {
  missingAlbumArtist: MissingAlbumArtistIssue
  yearMismatch: YearMismatchIssue
  duplicates: DuplicateIssue
  artistVariants: ArtistVariantIssue
}

export interface IssueSummary {
  /** Groups each check finds. */
  groups: Record<IssueCheck, number>
  /**
   * Tracks not re-read since migration 028. The album-artist and year checks
   * cannot judge them; a Rescan fills them in.
   */
  tracksNotRescanned: number
}

/**
 * The fold the variant and duplicate checks compare on: decomposed, marks
 * stripped, case-folded, and everything but letters and digits removed. "AC/DC",
 * "ac-dc" and "Ac Dc" meet; "The Beatles" and "Beatles" do not — a missing word
 * is a different name, not a spelling of the same one.
 */
export function foldName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

// --- The store ----------------------------------------------------------------

interface Where {
  clauses: string[]
  params: unknown[]
}

/** `!` rather than a backslash as the LIKE escape: it reads the same and is not a path separator. */
function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (char) => `!${char}`)
}

function addText(where: Where, column: string, match: TextMatch | undefined): void {
  if (!match) return
  if ('equals' in match) {
    where.clauses.push(`${column} = ? COLLATE NOCASE`)
    where.params.push(match.equals)
  } else {
    where.clauses.push(`${column} LIKE ? ESCAPE '!'`)
    where.params.push(`%${escapeLike(match.contains)}%`)
  }
}

function addRange(where: Where, column: string, min?: number, max?: number): void {
  if (min !== undefined) {
    where.clauses.push(`${column} >= ?`)
    where.params.push(min)
  }
  if (max !== undefined) {
    where.clauses.push(`${column} <= ?`)
    where.params.push(max)
  }
}

function whereSql(where: Where): string {
  return where.clauses.length === 0 ? '' : `WHERE ${where.clauses.join('\n  AND ')}`
}

function trackWhere(filter: AgentTrackFilter): Where {
  const where: Where = { clauses: [], params: [] }
  addText(where, 't.title', filter.title)
  addText(where, 'ar.name', filter.artist)
  addText(where, 'al.title', filter.album)
  addText(where, 'aa.name', filter.albumArtist)
  addText(where, 'COALESCE(o.genre, t.genre)', filter.genre)
  addText(where, 't.rel_path', filter.path)
  if (filter.root !== undefined) {
    where.clauses.push('r.label = ? COLLATE NOCASE')
    where.params.push(filter.root)
  }
  if (filter.codecs && filter.codecs.length > 0) {
    where.clauses.push(`t.codec IN (SELECT value FROM json_each(?))`)
    where.params.push(JSON.stringify(filter.codecs))
  }
  addRange(where, 'al.year', filter.yearMin, filter.yearMax)
  addRange(
    where,
    't.duration_ms',
    filter.durationSecMin === undefined ? undefined : filter.durationSecMin * 1000,
    filter.durationSecMax === undefined ? undefined : filter.durationSecMax * 1000
  )
  addRange(where, 't.play_count', filter.playCountMin, filter.playCountMax)
  addRange(where, 't.last_played_at', filter.lastPlayedFrom, filter.lastPlayedTo)
  if (filter.favorite !== undefined) {
    where.clauses.push(filter.favorite ? 'fav.track_id IS NOT NULL' : 'fav.track_id IS NULL')
  }
  if (filter.hasCorrections !== undefined) {
    where.clauses.push(`${filter.hasCorrections ? '' : 'NOT '}${FIELD_SQL.hasCorrections}`)
  }
  if (filter.userTag !== undefined) {
    where.clauses.push(`EXISTS (
      SELECT 1 FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id
      WHERE tt.track_id = t.id AND tg.label = ? COLLATE NOCASE)`)
    where.params.push(filter.userTag)
  }
  if (filter.albumId !== undefined) {
    where.clauses.push('t.album_id = ?')
    where.params.push(filter.albumId)
  }
  if (filter.artistId !== undefined) {
    where.clauses.push('(t.artist_id = ? OR al.album_artist_id = ?)')
    where.params.push(filter.artistId, filter.artistId)
  }
  for (const field of filter.present ?? []) where.clauses.push(`(${PRESENCE_SQL[field]})`)
  for (const field of filter.missing ?? []) where.clauses.push(`NOT (${PRESENCE_SQL[field]})`)
  return where
}

/** `<alias>.<column> AS "<field>"` for each asked-for field, plus the id. */
function projection(fields: readonly AgentTrackField[]): string {
  return ['t.id AS id', ...fields.map((field) => `${FIELD_SQL[field]} AS "${field}"`)].join(',\n  ')
}

function toAgentTrack(
  row: Record<string, unknown>,
  fields: readonly AgentTrackField[]
): AgentTrack {
  const track: AgentTrack = { id: row.id as number }
  for (const field of fields) track[field] = fieldValue(field, row[field])
  return track
}

export class AgentReadStore {
  constructor(private readonly db: Database.Database) {}

  findTracks(query: AgentTrackQuery): Page<AgentTrack> {
    const where = trackWhere(query.filter)
    const sql = whereSql(where)
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total ${AGENT_TRACK_JOINS} ${sql}`)
      .get(...where.params) as { total: number }
    const rows = this.db
      .prepare(
        `SELECT ${projection(query.fields)} ${AGENT_TRACK_JOINS} ${sql}
         ORDER BY ${TRACK_ORDER[query.sort]} LIMIT ? OFFSET ?`
      )
      .all(...where.params, query.limit, query.offset) as Record<string, unknown>[]
    return { rows: rows.map((row) => toAgentTrack(row, query.fields)), total }
  }

  /** The tracks named, in the order named; an id with no track is left out. */
  getTracks(ids: readonly number[], fields: readonly AgentTrackField[]): AgentTrack[] {
    if (ids.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT ${projection(fields)} ${AGENT_TRACK_JOINS}
         WHERE t.id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(ids)) as Record<string, unknown>[]
    const byId = new Map(rows.map((row) => [row.id as number, toAgentTrack(row, fields)]))
    return [...new Set(ids)].flatMap((id) => byId.get(id) ?? [])
  }

  findAlbums(query: AgentAlbumQuery): Page<AgentAlbum> {
    const where: Where = { clauses: [], params: [] }
    addText(where, 'al.title', query.title)
    addText(where, 'aa.name', query.albumArtist)
    addRange(where, 'al.year', query.yearMin, query.yearMax)
    if (query.artistId !== undefined) {
      where.clauses.push(`(al.album_artist_id = ? OR EXISTS (
        SELECT 1 FROM tracks pt WHERE pt.album_id = al.id AND pt.artist_id = ?))`)
      where.params.push(query.artistId, query.artistId)
    }
    // Only albums something still points at: a re-key can leave an empty row.
    where.clauses.push('EXISTS (SELECT 1 FROM tracks et WHERE et.album_id = al.id)')
    const sql = `FROM albums al LEFT JOIN artists aa ON aa.id = al.album_artist_id ${whereSql(where)}`
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total ${sql}`).get(...where.params) as {
      total: number
    }
    const rows = this.db
      .prepare(
        `SELECT al.id AS id, al.title AS title, aa.name AS albumArtist,
                al.album_artist_id AS albumArtistId, al.year AS year,
                (SELECT COUNT(*) FROM tracks ct WHERE ct.album_id = al.id) AS tracks,
                (SELECT ROUND(COALESCE(SUM(ct.duration_ms), 0) / 1000.0)
                   FROM tracks ct WHERE ct.album_id = al.id) AS durationSec
         ${sql}
         ORDER BY aa.name COLLATE NOCASE, al.title COLLATE NOCASE, al.id
         LIMIT ? OFFSET ?`
      )
      .all(...where.params, query.limit, query.offset) as AgentAlbum[]
    return { rows, total }
  }

  findArtists(query: AgentArtistQuery): Page<AgentArtist> {
    const where: Where = { clauses: [], params: [] }
    addText(where, 'a.name', query.name)
    where.clauses.push(`(EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id)
       OR EXISTS (SELECT 1 FROM albums al JOIN tracks t ON t.album_id = al.id
                  WHERE al.album_artist_id = a.id))`)
    const sql = `FROM artists a ${whereSql(where)}`
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total ${sql}`).get(...where.params) as {
      total: number
    }
    const rows = this.db
      .prepare(
        `SELECT a.id AS id, a.name AS name,
                (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) AS tracks,
                (SELECT COUNT(*) FROM albums al WHERE al.album_artist_id = a.id
                   AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)) AS albums
         ${sql}
         ORDER BY a.name COLLATE NOCASE, a.id
         LIMIT ? OFFSET ?`
      )
      .all(...where.params, query.limit, query.offset) as AgentArtist[]
    return { rows, total }
  }

  issueSummary(): IssueSummary {
    const { tracksNotRescanned } = this.db
      .prepare('SELECT COUNT(*) AS tracksNotRescanned FROM tracks WHERE tag_album_artist IS NULL')
      .get() as { tracksNotRescanned: number }
    return {
      groups: {
        missingAlbumArtist: this.missingAlbumArtist().length,
        yearMismatch: this.yearMismatch().length,
        duplicates: this.duplicates().length,
        artistVariants: this.artistVariants().length
      },
      tracksNotRescanned
    }
  }

  /** Every group one check finds, in a stable order the caller pages over. */
  issues<C extends IssueCheck>(check: C): IssueGroups[C][] {
    const run: { [K in IssueCheck]: () => IssueGroups[K][] } = {
      missingAlbumArtist: () => this.missingAlbumArtist(),
      yearMismatch: () => this.yearMismatch(),
      duplicates: () => this.duplicates(),
      artistVariants: () => this.artistVariants()
    }
    return run[check]()
  }

  private missingAlbumArtist(): MissingAlbumArtistIssue[] {
    const rows = this.db
      .prepare(
        `SELECT al.id AS albumId, al.title AS album, aa.name AS shownUnder,
                COUNT(*) AS tracksMissing, json_group_array(t.id) AS trackIds
         FROM tracks t
         JOIN albums al ON al.id = t.album_id
         LEFT JOIN artists aa ON aa.id = al.album_artist_id
         LEFT JOIN track_overrides o ON o.track_id = t.id
         WHERE NOT ${ALBUM_ARTIST_PRESENT_SQL}
         GROUP BY al.id
         ORDER BY al.title COLLATE NOCASE, al.id`
      )
      .all() as (Omit<MissingAlbumArtistIssue, 'trackIds'> & { trackIds: string })[]
    return rows.map((row) => ({
      ...row,
      trackIds: (JSON.parse(row.trackIds) as number[])
        .sort((a, b) => a - b)
        .slice(0, ISSUE_GROUP_ID_CAP)
    }))
  }

  private yearMismatch(): YearMismatchIssue[] {
    // Each track's own year: a correction if one stands, else the file's tag.
    const rows = this.db
      .prepare(
        `SELECT g.album_id AS albumId, al.title AS album, aa.name AS albumArtist,
                al.year AS shownYear,
                json_group_array(json_object('year', g.track_year, 'tracks', g.tracks)) AS years
         FROM (
           -- Not aliased "year": GROUP BY would bind that to o.year, the column.
           SELECT t.album_id, COALESCE(o.year, t.tag_year) AS track_year, COUNT(*) AS tracks
           FROM tracks t LEFT JOIN track_overrides o ON o.track_id = t.id
           WHERE t.album_id IS NOT NULL AND COALESCE(o.year, t.tag_year) IS NOT NULL
           GROUP BY t.album_id, track_year
         ) g
         JOIN albums al ON al.id = g.album_id
         LEFT JOIN artists aa ON aa.id = al.album_artist_id
         GROUP BY g.album_id
         HAVING COUNT(*) > 1
         ORDER BY al.title COLLATE NOCASE, al.id`
      )
      .all() as (Omit<YearMismatchIssue, 'years'> & { years: string })[]
    return rows.map((row) => ({
      ...row,
      years: (JSON.parse(row.years) as YearMismatchIssue['years']).sort((a, b) => a.year - b.year)
    }))
  }

  private duplicates(): DuplicateIssue[] {
    // A fold the database cannot do (SQLite's lower() is ASCII-only), so the
    // narrow columns come across once and group here.
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.title AS title, ar.name AS artist, al.title AS album,
                t.duration_ms AS durationMs, t.codec AS codec, r.label AS root, t.rel_path AS path
         FROM tracks t
         JOIN roots r ON r.id = t.root_id
         JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums al ON al.id = t.album_id
         WHERE t.title IS NOT NULL AND t.duration_ms IS NOT NULL`
      )
      .all() as {
      id: number
      title: string
      artist: string
      album: string | null
      durationMs: number
      codec: string | null
      root: string
      path: string
    }[]
    const byKey = new Map<string, typeof rows>()
    for (const row of rows) {
      const artist = foldName(row.artist)
      const title = foldName(row.title)
      if (artist === '' || title === '') continue
      const key = `${artist}\u0000${title}`
      const bucket = byKey.get(key)
      if (bucket) bucket.push(row)
      else byKey.set(key, [row])
    }
    const groups: DuplicateIssue[] = []
    for (const bucket of byKey.values()) {
      if (bucket.length < 2) continue
      bucket.sort((a, b) => a.durationMs - b.durationMs || a.id - b.id)
      // Chain by neighbour: copies within the tolerance of the one before.
      let run: typeof rows = [bucket[0]!]
      const flush = (): void => {
        if (run.length < 2) return
        const sorted = [...run].sort((a, b) => a.id - b.id)
        groups.push({
          artist: sorted[0]!.artist,
          title: sorted[0]!.title,
          tracks: sorted.map((row) => ({
            id: row.id,
            album: row.album,
            durationSec: Math.round(row.durationMs / 100) / 10,
            codec: row.codec,
            root: row.root,
            path: row.path
          }))
        })
      }
      for (const row of bucket.slice(1)) {
        if (row.durationMs - run[run.length - 1]!.durationMs <= DUPLICATE_DURATION_TOLERANCE_MS) {
          run.push(row)
        } else {
          flush()
          run = [row]
        }
      }
      flush()
    }
    return groups.sort(
      (a, b) =>
        a.artist.localeCompare(b.artist) ||
        a.title.localeCompare(b.title) ||
        a.tracks[0]!.id - b.tracks[0]!.id
    )
  }

  private artistVariants(): ArtistVariantIssue[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS artistId, a.name AS name,
                (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) AS tracks
         FROM artists a
         WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id)
            OR EXISTS (SELECT 1 FROM albums al JOIN tracks t ON t.album_id = al.id
                       WHERE al.album_artist_id = a.id)
         ORDER BY a.id`
      )
      .all() as ArtistVariantIssue['variants']
    const byKey = new Map<string, ArtistVariantIssue['variants']>()
    for (const row of rows) {
      const key = foldName(row.name)
      if (key === '') continue
      const bucket = byKey.get(key)
      if (bucket) bucket.push(row)
      else byKey.set(key, [row])
    }
    return [...byKey.values()]
      .filter((variants) => variants.length > 1)
      .map((variants) => ({ variants }))
      .sort((a, b) => a.variants[0]!.name.localeCompare(b.variants[0]!.name))
  }
}
