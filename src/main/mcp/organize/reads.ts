import type Database from 'better-sqlite3'

/**
 * The reads the Organize tools plan against — **W24-7**, `oscine-mcp` → D36.5.
 *
 * Plain SQL on main's connection, and only reads: every write still goes
 * through `PlaylistService` or `TagStore`. These exist so a tool can validate
 * its input and work out the diff it is about to apply (or, with `dryRun`,
 * would apply) without writing anything to find out.
 */

export interface OrganizeEntry {
  entryId: number
  trackId: number
}

export interface OrganizeTag {
  id: number
  key: string
  label: string
}

export interface OrganizeReads {
  /** The playlist's entries in playing order; `[]` for an unknown playlist. */
  entries(playlistId: number): OrganizeEntry[]
  /** Which of these ids are tracks in the library. */
  existingTracks(trackIds: readonly number[]): Set<number>
  /** The vocabulary row with this normalised key, if any. */
  tagByKey(key: string): OrganizeTag | null
  /** Which of these tracks carry the tag. */
  tracksWithTag(tagId: number, trackIds: readonly number[]): Set<number>
}

export function createOrganizeReads(db: Database.Database): OrganizeReads {
  const statements = {
    entries: db.prepare(
      `SELECT id AS entryId, track_id AS trackId FROM playlist_entries
       WHERE playlist_id = ? ORDER BY position ASC, id ASC`
    ),
    existingTracks: db.prepare(
      'SELECT id FROM tracks WHERE id IN (SELECT value FROM json_each(?))'
    ),
    tagByKey: db.prepare('SELECT id, key, label FROM tags WHERE key = ?'),
    tracksWithTag: db.prepare(
      `SELECT track_id AS id FROM track_tags
       WHERE tag_id = ? AND track_id IN (SELECT value FROM json_each(?))`
    )
  }
  const idSet = (rows: unknown[]): Set<number> =>
    new Set((rows as Array<{ id: number }>).map((row) => row.id))

  return {
    entries: (playlistId) => statements.entries.all(playlistId) as OrganizeEntry[],
    existingTracks: (trackIds) =>
      idSet(statements.existingTracks.all(JSON.stringify([...new Set(trackIds)]))),
    tagByKey: (key) => (statements.tagByKey.get(key) as OrganizeTag | undefined) ?? null,
    tracksWithTag: (tagId, trackIds) =>
      idSet(statements.tracksWithTag.all(tagId, JSON.stringify([...new Set(trackIds)])))
  }
}
