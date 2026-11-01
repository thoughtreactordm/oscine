import type Database from 'better-sqlite3'
import { OVERRIDE_FIELDS, type OverrideField } from '@shared/overrides'
import { isTagFieldKey, type TagFieldKey } from '@shared/tagFields'
import { resolveCodecWriter } from '../../library/writeback/writer'

/**
 * The reads the Stage corrections tools plan against — **W24-8**,
 * `oscine-mcp` → D36.5.
 *
 * Plain SQL on main's connection, and only reads: every write goes through
 * `LibraryService`'s override methods, the ones `overrides.set` and
 * `tagOverrides.set` call. Nothing here returns a path — writability is
 * decided from the relative path's extension, the same table the write-back
 * engine refuses formats by, and only the verdict leaves this module.
 */

export interface StagedFields {
  readonly grouped: readonly OverrideField[]
  readonly registry: readonly TagFieldKey[]
}

export interface StageReads {
  /**
   * The library's tracks among these ids, each with whether write-back can
   * write its format. An id that is not a track is absent.
   */
  tracks(trackIds: readonly number[]): Map<number, { writable: boolean }>
  /** The fields each of these tracks has a staged correction for; none → absent. */
  stagedFields(trackIds: readonly number[]): Map<number, StagedFields>
  /** Tracks whose staged corrections a changeset changed and has not reverted. */
  changesetTracks(changesetId: number): number[]
}

/** `track_overrides` column per grouped field — the store's own mapping. */
const OVERRIDE_COLUMNS: Readonly<Record<OverrideField, string>> = {
  title: 'title',
  artist: 'artist_name',
  albumArtist: 'album_artist_name',
  album: 'album_title',
  trackNo: 'track_no',
  discNo: 'disc_no',
  year: 'year',
  genre: 'genre'
}

export function createStageReads(db: Database.Database): StageReads {
  const statements = {
    tracks: db.prepare(
      `SELECT id, rel_path AS relPath FROM tracks
       WHERE id IN (SELECT value FROM json_each(?))`
    ),
    grouped: db.prepare(
      `SELECT track_id AS trackId, ${OVERRIDE_FIELDS.map(
        (field) => `${OVERRIDE_COLUMNS[field]} IS NOT NULL AS "${field}"`
      ).join(', ')}
       FROM track_overrides WHERE track_id IN (SELECT value FROM json_each(?))`
    ),
    registry: db.prepare(
      `SELECT track_id AS trackId, field FROM track_tag_overrides
       WHERE track_id IN (SELECT value FROM json_each(?)) ORDER BY track_id, field`
    ),
    changesetTracks: db.prepare(
      `SELECT DISTINCT entity_id AS id FROM agent_changes
       WHERE changeset_id = ? AND reverted_at IS NULL
         AND entity_kind IN ('override', 'tagOverride')
       ORDER BY entity_id`
    )
  }
  const ids = (trackIds: readonly number[]): string => JSON.stringify([...new Set(trackIds)])

  return {
    tracks(trackIds) {
      const out = new Map<number, { writable: boolean }>()
      for (const row of statements.tracks.all(ids(trackIds)) as Array<{
        id: number
        relPath: string
      }>) {
        out.set(row.id, { writable: resolveCodecWriter(row.relPath) !== null })
      }
      return out
    },

    stagedFields(trackIds) {
      const grouped = new Map<number, OverrideField[]>()
      for (const row of statements.grouped.all(ids(trackIds)) as Array<
        Record<string, number> & { trackId: number }
      >) {
        const fields = OVERRIDE_FIELDS.filter((field) => row[field] === 1)
        if (fields.length > 0) grouped.set(row.trackId, fields)
      }
      const registry = new Map<number, TagFieldKey[]>()
      for (const row of statements.registry.all(ids(trackIds)) as Array<{
        trackId: number
        field: string
      }>) {
        if (!isTagFieldKey(row.field)) continue
        const list = registry.get(row.trackId) ?? []
        list.push(row.field)
        registry.set(row.trackId, list)
      }
      const out = new Map<number, StagedFields>()
      for (const trackId of new Set([...grouped.keys(), ...registry.keys()])) {
        out.set(trackId, {
          grouped: grouped.get(trackId) ?? [],
          registry: registry.get(trackId) ?? []
        })
      }
      return out
    },

    changesetTracks: (changesetId) =>
      (statements.changesetTracks.all(changesetId) as Array<{ id: number }>).map((row) => row.id)
  }
}
