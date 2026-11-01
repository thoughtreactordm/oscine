import type Database from 'better-sqlite3'
import type { OverrideField } from '@shared/overrides'
import type { AgentProvenance, WritebackField } from '@shared/tagWriteback'
import { journalJson, type JournalEntities } from './entities'

/**
 * Which staged corrections an agent made — **W24-8**, `oscine-mcp` → D36.6.
 *
 * The write-back review badges a row whose correction came from a changeset.
 * That is a join against `agent_changes` when the review loads, not a column on
 * the override tables (which a manual edit would then have to clear): for each
 * (track, field) the newest unreverted change is the agent's claim, and it
 * holds only while the field still reads exactly the value that change left.
 * An operator edit after it, or a revert, reads differently and drops the badge
 * — the same string comparison a revert's conflict test makes.
 */
export interface AgentProvenanceResolver {
  /** Provenance for the tracks that have any; the rest are absent from the map. */
  forTracks(trackIds: readonly number[]): Map<number, AgentProvenance>
}

/** A grouped override field's name in the review: genre is the review's `genres`. */
const REVIEW_FIELD: Readonly<Record<OverrideField, WritebackField>> = {
  title: 'title',
  artist: 'artist',
  albumArtist: 'albumArtist',
  album: 'album',
  trackNo: 'trackNo',
  discNo: 'discNo',
  year: 'year',
  genre: 'genres'
}

interface ClaimRow {
  kind: 'override' | 'tagOverride'
  entityId: number
  field: string
  after: string
  changesetId: number
}

export function createAgentProvenance(deps: {
  db: Database.Database
  entities: Pick<JournalEntities, 'override' | 'tagOverride'>
}): AgentProvenanceResolver {
  const { db, entities } = deps
  // The newest unreverted change per (kind, track, field). One pass over the
  // journal per review load; the journal holds changes, not the library.
  const claims = db.prepare(
    `SELECT kind, entityId, field, after, changesetId FROM (
       SELECT entity_kind AS kind, entity_id AS entityId, field, after_json AS after,
              changeset_id AS changesetId,
              ROW_NUMBER() OVER (
                PARTITION BY entity_kind, entity_id, field ORDER BY id DESC
              ) AS rn
       FROM agent_changes
       WHERE entity_kind IN ('override', 'tagOverride') AND reverted_at IS NULL
     ) WHERE rn = 1`
  )

  return {
    forTracks(trackIds) {
      const out = new Map<number, AgentProvenance>()
      if (trackIds.length === 0) return out
      const wanted = new Set(trackIds)
      const found = new Map<number, { fields: Set<WritebackField>; changesets: Set<number> }>()
      for (const row of claims.all() as ClaimRow[]) {
        if (!wanted.has(row.entityId)) continue
        let current: string
        try {
          current = journalJson(entities[row.kind].read(row.entityId, row.field))
        } catch {
          // A field this build no longer knows is nobody's badge.
          continue
        }
        if (current !== row.after) continue
        const field =
          row.kind === 'override'
            ? REVIEW_FIELD[row.field as OverrideField]
            : (row.field as WritebackField)
        if (field === undefined) continue
        let entry = found.get(row.entityId)
        if (entry === undefined) {
          entry = { fields: new Set(), changesets: new Set() }
          found.set(row.entityId, entry)
        }
        entry.fields.add(field)
        entry.changesets.add(row.changesetId)
      }
      for (const [trackId, entry] of found) {
        out.set(trackId, {
          fields: [...entry.fields],
          changesetIds: [...entry.changesets].sort((a, b) => a - b)
        })
      }
      return out
    }
  }
}
