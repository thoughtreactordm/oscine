import type Database from 'better-sqlite3'
import type { AgentCapability } from '@shared/agentAccess'
import type { JournalEntityKind } from '@shared/agentChangesets'
import { OVERRIDE_FIELDS, type OverrideField, type OverridePatch } from '@shared/overrides'
import {
  tagField,
  type TagFieldKey,
  type TagFieldPatch,
  type TagFieldValue
} from '@shared/tagFields'
import type { TagSource } from '@shared/tags'
import type { PlaylistService } from '../../library/playlists/service'
import type { LibraryService } from '../../library/service'
import type { TagStore } from '../../tags/store'

/**
 * How the journal reads and restores each kind of thing an agent can change —
 * **W24-6**, `oscine-mcp` → D36.5/D36.6.
 *
 * Each entity kind is a `read` and a `write` over one `(entity id, field)`:
 *
 * - **`read`** is plain SQL on main's connection and returns the field's value
 *   in a canonical JSON form, so two reads of the same state serialise to the
 *   same string. That string equality is the whole conflict test.
 * - **`write`** goes through the service a manual edit uses (D36.5) — never
 *   SQL — so a revert stages, announces and materialises exactly as the
 *   operator's own edit would. A write that would destroy something the value
 *   does not describe throws {@link JournalConflictError} instead.
 *
 * The values, per kind and field:
 *
 * | kind | field | value |
 * |---|---|---|
 * | `playlist` | `name` | the name, or `null` when the playlist does not exist |
 * | `playlist` | `position` | its index in the rail, or `null` when absent |
 * | `playlistEntries` | `entries` | track ids in playing order (`[]` when absent: it has none) |
 * | `override` | an {@link OverrideField} | the staged correction, or `null` for none |
 * | `tagOverride` | a registry key | `{ value }` (value `null` is a staged clear), or `null` for none |
 * | `tags` | `labels` | `[{ key, label, source }]` sorted by key |
 *
 * A later card that journals a new kind of write (W24-9's smart-playlist fields)
 * adds its field here, with a test that a write and a read round-trip.
 */

export type JournalValue =
  | null
  | string
  | number
  | boolean
  | readonly JournalValue[]
  | { readonly [key: string]: JournalValue }

/** The canonical serialisation the journal stores and compares. */
export function journalJson(value: JournalValue): string {
  return JSON.stringify(value)
}

/** A restore that would destroy something the recorded value does not describe. */
export class JournalConflictError extends Error {}

/** A field this build does not know how to read or write. */
export class JournalFieldError extends Error {}

export interface JournalEntity {
  kind: JournalEntityKind
  /** The capability an agent needs to change (or revert) this kind (D36.7). */
  capability: AgentCapability
  read(entityId: number, field: string): JournalValue
  write(entityId: number, field: string, value: JournalValue): Promise<void>
}

export interface JournalEntityDeps {
  db: Database.Database
  playlists: Pick<PlaylistService, 'rename' | 'delete' | 'reorder' | 'addTracks' | 'removeEntries'>
  library: Pick<
    LibraryService,
    'setOverrides' | 'clearOverrides' | 'setTagOverrides' | 'revertTagOverrides'
  >
  tags: Pick<TagStore, 'addTag' | 'removeTag'>
}

export type JournalEntities = Readonly<Record<JournalEntityKind, JournalEntity>>

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

const NUMERIC_OVERRIDES: ReadonlySet<OverrideField> = new Set(['trackNo', 'discNo', 'year'])

function overrideField(field: string): OverrideField {
  if (!(OVERRIDE_FIELDS as readonly string[]).includes(field)) {
    throw new JournalFieldError(`"${field}" is not a grouped override field.`)
  }
  return field as OverrideField
}

function tagOverrideKey(field: string): TagFieldKey {
  if (tagField(field) === undefined) {
    throw new JournalFieldError(`"${field}" is not a tag field this build knows.`)
  }
  return field as TagFieldKey
}

interface TagRow {
  id: number
  key: string
  label: string
  source: TagSource
}

export function createJournalEntities(deps: JournalEntityDeps): JournalEntities {
  const { db } = deps
  const statements = {
    playlistName: db.prepare('SELECT name FROM playlists WHERE id = ?'),
    tabIds: db.prepare('SELECT id FROM playlists ORDER BY position ASC, id ASC'),
    entries: db.prepare(
      'SELECT id, track_id AS trackId FROM playlist_entries WHERE playlist_id = ? ORDER BY position ASC, id ASC'
    ),
    tagOverride: db.prepare(
      'SELECT value FROM track_tag_overrides WHERE track_id = ? AND field = ?'
    ),
    trackTags: db.prepare(
      `SELECT t.id, t.key, t.label, tt.source
       FROM track_tags tt JOIN tags t ON t.id = tt.tag_id
       WHERE tt.track_id = ? ORDER BY t.key`
    )
  }
  const overrideReads = new Map(
    OVERRIDE_FIELDS.map((field) => [
      field,
      db.prepare(
        `SELECT ${OVERRIDE_COLUMNS[field]} AS value FROM track_overrides WHERE track_id = ?`
      )
    ])
  )

  const playlistExists = (id: number): boolean => statements.playlistName.get(id) !== undefined
  const entryRows = (playlistId: number): Array<{ id: number; trackId: number }> =>
    statements.entries.all(playlistId) as Array<{ id: number; trackId: number }>
  const tagRows = (trackId: number): TagRow[] => statements.trackTags.all(trackId) as TagRow[]

  const playlist: JournalEntity = {
    kind: 'playlist',
    capability: 'organize',
    read(id, field) {
      if (field === 'name') {
        const row = statements.playlistName.get(id) as { name: string } | undefined
        return row?.name ?? null
      }
      if (field === 'position') {
        const index = (statements.tabIds.all() as Array<{ id: number }>).findIndex(
          (row) => row.id === id
        )
        return index === -1 ? null : index
      }
      throw new JournalFieldError(`"${field}" is not a journaled playlist field.`)
    },
    async write(id, field, value) {
      if (field === 'name') {
        if (value === null) {
          // Undoing a create. Only an empty playlist goes: entries the agent
          // added are a separate change reverted before this one, so any left
          // are someone else's, and deleting would take them too.
          if (!playlistExists(id)) return
          if (entryRows(id).length > 0) {
            throw new JournalConflictError('The playlist has entries that are not the agent’s.')
          }
          await deps.playlists.delete(id)
          return
        }
        if (typeof value !== 'string') throw new JournalFieldError('A name is a string.')
        await deps.playlists.rename(id, value)
        return
      }
      if (field === 'position') {
        if (typeof value !== 'number') throw new JournalConflictError('The playlist is gone.')
        await deps.playlists.reorder(id, value)
        return
      }
      throw new JournalFieldError(`"${field}" is not a journaled playlist field.`)
    }
  }

  const playlistEntries: JournalEntity = {
    kind: 'playlistEntries',
    capability: 'organize',
    read(id, field) {
      if (field !== 'entries') throw new JournalFieldError(`"${field}" is not an entries field.`)
      return entryRows(id).map((row) => row.trackId)
    },
    async write(id, field, value) {
      if (field !== 'entries') throw new JournalFieldError(`"${field}" is not an entries field.`)
      if (!Array.isArray(value)) throw new JournalFieldError('Entries are recorded as a list.')
      const target = value as number[]
      if (!playlistExists(id)) {
        if (target.length === 0) return
        throw new JournalConflictError('The playlist is gone.')
      }
      const current = entryRows(id)
      // Keep the longest common prefix — its entries keep their ids — and
      // rebuild the rest. Reverting an append is then a pure removal, and
      // reverting a removal from the end a pure append.
      let keep = 0
      while (
        keep < current.length &&
        keep < target.length &&
        current[keep]!.trackId === target[keep]
      ) {
        keep += 1
      }
      const drop = current.slice(keep).map((row) => row.id)
      if (drop.length > 0) await deps.playlists.removeEntries({ playlistId: id, entryIds: drop })
      const add = target.slice(keep)
      if (add.length > 0) {
        await deps.playlists.addTracks({ playlistId: id, trackIds: add, insertion: { at: 'end' } })
      }
    }
  }

  const override: JournalEntity = {
    kind: 'override',
    capability: 'stage',
    read(trackId, field) {
      const row = overrideReads.get(overrideField(field))!.get(trackId) as
        { value: string | number | null } | undefined
      return row?.value ?? null
    },
    async write(trackId, field, value) {
      const key = overrideField(field)
      if (value === null) {
        await deps.library.clearOverrides({ trackIds: [trackId], fields: [key] })
        return
      }
      const numeric = NUMERIC_OVERRIDES.has(key)
      if (numeric ? typeof value !== 'number' : typeof value !== 'string') {
        throw new JournalFieldError(`${key} takes a ${numeric ? 'number' : 'string'}.`)
      }
      const patch = { [key]: value } as OverridePatch
      await deps.library.setOverrides({ trackIds: [trackId], patch })
    }
  }

  const tagOverride: JournalEntity = {
    kind: 'tagOverride',
    capability: 'stage',
    read(trackId, field) {
      const row = statements.tagOverride.get(trackId, tagOverrideKey(field)) as
        { value: string } | undefined
      if (row === undefined) return null
      let value: JournalValue
      try {
        value = JSON.parse(row.value) as JournalValue
      } catch {
        // Unparseable is still a value, and still not the agent's.
        value = row.value
      }
      return { value }
    },
    async write(trackId, field, value) {
      const key = tagOverrideKey(field)
      if (value === null) {
        await deps.library.revertTagOverrides({ trackIds: [trackId], fields: [key] })
        return
      }
      if (typeof value !== 'object' || Array.isArray(value) || !('value' in value)) {
        throw new JournalFieldError('A tag override is recorded as { value }.')
      }
      const patch = { [key]: value.value as TagFieldValue | null } as TagFieldPatch
      await deps.library.setTagOverrides({ trackIds: [trackId], patch })
    }
  }

  const tags: JournalEntity = {
    kind: 'tags',
    capability: 'organize',
    read(trackId, field) {
      if (field !== 'labels') throw new JournalFieldError(`"${field}" is not a tags field.`)
      return tagRows(trackId).map((row) => ({ key: row.key, label: row.label, source: row.source }))
    },
    async write(trackId, field, value) {
      if (field !== 'labels') throw new JournalFieldError(`"${field}" is not a tags field.`)
      if (!Array.isArray(value)) throw new JournalFieldError('Tags are recorded as a list.')
      const target = new Map(
        (value as Array<{ key: string; label: string; source: TagSource }>).map((tag) => [
          tag.key,
          tag
        ])
      )
      const current = tagRows(trackId)
      for (const row of current) {
        const wanted = target.get(row.key)
        if (wanted === undefined || wanted.source !== row.source) {
          deps.tags.removeTag([trackId], row.id)
        }
      }
      const kept = new Map(current.map((row) => [row.key, row]))
      for (const [key, tag] of target) {
        const had = kept.get(key)
        if (had === undefined || had.source !== tag.source) {
          deps.tags.addTag([trackId], tag.label, tag.source)
        }
      }
    }
  }

  return { playlist, playlistEntries, override, tagOverride, tags }
}
