import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { OscineError } from '@shared/errors'
import { normalizeLabel } from '@shared/genre'
import {
  MAX_PLAYLIST_AGENT_NOTES_LENGTH,
  MAX_PLAYLIST_BATCH,
  MAX_PLAYLIST_BRIEF_LENGTH,
  MAX_PLAYLIST_NAME_LENGTH,
  PLAYLIST_KINDS,
  type Playlist
} from '@shared/playlists'
import { MAX_TAG_LABEL_LENGTH } from '@shared/tags'
import type { PlaylistService } from '../../library/playlists/service'
import type { TagStore } from '../../tags/store'
import type { JournalTarget, JournalWrite } from '../journal/journal'
import type { AgentSessionJournal } from '../journal/session'
import {
  assertEntriesInPlaylist,
  assertWithinCap,
  insertionIndex,
  listIds,
  MAX_ORGANIZE_BATCH,
  planMove,
  planOrder
} from '../organize/plan'
import type { OrganizeReads } from '../organize/reads'
import { DATA_NOTE, errorResult, guarded, idInput, jsonResult, ToolInputError } from './common'

/**
 * The Organize capability's tools — **W24-7**, `oscine-mcp` → D36.5, D36.7.
 *
 * Playlists through `PlaylistService` and user tags (W15) through `TagStore`:
 * the services the IPC handlers call, so an agent's edit is a manual edit in
 * every respect but who made it. Every write goes through the session's journal
 * wrapper (W24-6), which records it in the open changeset, stamps it `agent`,
 * and sends one `library.changed` for the whole call however many rows moved.
 *
 * Every tool takes `dryRun`, which plans the edit against the library as it is
 * and returns the diff without writing (D36.7). A real call runs the same plan
 * first, so an anchor that is not there or an entry from another playlist is a
 * readable error rather than an edit the store would quietly half-apply.
 *
 * Smart playlists (W24-9, D36.8) are Organize too: `set_smart_playlist` and
 * `update_agent_notes` write the playlist's own fields, an add to a smart
 * playlist skips its excluded tracks (and says which), and a removal takes
 * `exclude` to keep what it took out from coming back.
 *
 * Not here, on purpose: `delete_playlist` (deferred — an agent can empty one,
 * and the journal restores it) and favorites, which push to Last.fm (D19).
 */

export interface OrganizeDeps {
  playlists: Pick<
    PlaylistService,
    | 'list'
    | 'create'
    | 'rename'
    | 'reorder'
    | 'addTracks'
    | 'moveEntries'
    | 'removeEntries'
    | 'setKind'
    | 'setBrief'
    | 'setAgentNotes'
  >
  tags: Pick<TagStore, 'addTag' | 'removeTag'>
  reads: OrganizeReads
}

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const
const REMOVES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const

const DRY_RUN_NOTE =
  'With `dryRun: true` it returns the diff it would apply and writes nothing. The change joins ' +
  'your open changeset (see begin_changeset), which the operator can revert in one step.'

const CAP_NOTE = `At most ${MAX_ORGANIZE_BATCH} per call; split larger batches.`

const dryRunInput = z
  .boolean()
  .optional()
  .describe('Return the diff this call would apply, and write nothing.')

/** Ids in a batch. The schema bounds the payload; the 500 cap is checked with a readable error. */
const idBatch = z.array(idInput).min(1).max(MAX_PLAYLIST_BATCH)

const insertionInput = z
  .discriminatedUnion('at', [
    z.object({ at: z.literal('start') }).strict(),
    z.object({ at: z.literal('end') }).strict(),
    z.object({ at: z.literal('before'), entryId: idInput }).strict(),
    z.object({ at: z.literal('after'), entryId: idInput }).strict()
  ])
  .describe(
    'Where the block lands: `{at:"start"}`, `{at:"end"}`, or before/after an existing ' +
      '`entryId` from get_playlist.'
  )

const nameInput = z.string().max(MAX_PLAYLIST_NAME_LENGTH * 2)
const labelInput = z.string().max(MAX_TAG_LABEL_LENGTH * 2)

function playlistName(raw: string): string {
  const name = raw.trim()
  if (name.length === 0) throw new ToolInputError('A playlist name must not be empty.')
  if ([...name].length > MAX_PLAYLIST_NAME_LENGTH) {
    throw new ToolInputError(`A playlist name is at most ${MAX_PLAYLIST_NAME_LENGTH} characters.`)
  }
  return name
}

function tagLabel(raw: string): { key: string; label: string } {
  const norm = normalizeLabel(raw)
  if (norm === null) throw new ToolInputError('A tag label must not be empty.')
  if ([...norm.label].length > MAX_TAG_LABEL_LENGTH) {
    throw new ToolInputError(`A tag label is at most ${MAX_TAG_LABEL_LENGTH} characters.`)
  }
  return norm
}

const entriesTarget = (playlistId: number): JournalTarget => ({
  kind: 'playlistEntries',
  entityId: playlistId,
  field: 'entries'
})

const exclusionsTarget = (playlistId: number): JournalTarget => ({
  kind: 'playlist',
  entityId: playlistId,
  field: 'exclusions'
})

/** Trimmed, length-checked free text; blank means "clear it". */
function freeText(raw: string | null, what: string, max: number): string | null {
  const text = raw?.trim() ?? ''
  if (text.length === 0) return null
  if ([...text].length > max) throw new ToolInputError(`${what} is at most ${max} characters.`)
  return text
}

const tagsTarget = (trackId: number): JournalTarget => ({
  kind: 'tags',
  entityId: trackId,
  field: 'labels'
})

/** A tool body: input errors and a service's own refusals come back as tool errors. */
async function organizeGuarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return guarded(async () => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof OscineError) return errorResult(error.message)
      throw error
    }
  })
}

export function registerOrganizeTools(
  server: McpServer,
  deps: OrganizeDeps,
  session: { journal: AgentSessionJournal }
): RegisteredTool[] {
  const { playlists, tags, reads } = deps

  async function requirePlaylist(
    playlistId: number
  ): Promise<{ playlist: Playlist; index: number; count: number }> {
    const all = await playlists.list()
    const index = all.findIndex((playlist) => playlist.id === playlistId)
    if (index === -1)
      throw new ToolInputError(`No playlist has id ${playlistId}; see list_playlists.`)
    return { playlist: all[index]!, index, count: all.length }
  }

  function requireTracks(trackIds: readonly number[]): void {
    const found = reads.existingTracks(trackIds)
    const missing = [...new Set(trackIds)].filter((id) => !found.has(id))
    if (missing.length > 0) {
      throw new ToolInputError(
        `Tracks ${listIds(missing)} are not in the library; see find_tracks.`
      )
    }
  }

  /**
   * The dry run's answer, or the write through the journal with the same diff
   * and what the journal recorded.
   */
  async function commit<T>(
    dryRun: boolean | undefined,
    diff: Record<string, unknown>,
    write: JournalWrite<T>,
    after: (result: T) => Record<string, unknown> = () => ({})
  ): Promise<CallToolResult> {
    if (dryRun) return jsonResult({ dryRun: true, ...diff })
    const done = await session.journal.write(write)
    return jsonResult({
      dryRun: false,
      ...diff,
      ...after(done.result),
      changesetId: done.changesetId,
      recorded: done.recorded
    })
  }

  const create = server.registerTool(
    'create_playlist',
    {
      title: 'Create playlist',
      description:
        'Create an empty playlist at the end of the playlist rail, and return its id. Fill it ' +
        `with add_to_playlist. ${DRY_RUN_NOTE}`,
      inputSchema: z.object({ name: nameInput, dryRun: dryRunInput }).strict(),
      annotations: WRITE
    },
    ({ name, dryRun }) =>
      organizeGuarded(async () => {
        const clean = playlistName(name)
        const position = (await playlists.list()).length
        return commit(
          dryRun,
          { created: { name: clean, position } },
          {
            targets: [],
            apply: () => playlists.create(clean),
            created: (playlist) => [{ kind: 'playlist', entityId: playlist.id, field: 'name' }]
          },
          (playlist) => ({ playlistId: playlist.id })
        )
      })
  )

  const rename = server.registerTool(
    'rename_playlist',
    {
      title: 'Rename playlist',
      description: `Rename a playlist. ${DRY_RUN_NOTE} ${DATA_NOTE}`,
      inputSchema: z.object({ playlistId: idInput, name: nameInput, dryRun: dryRunInput }).strict(),
      annotations: WRITE
    },
    ({ playlistId, name, dryRun }) =>
      organizeGuarded(async () => {
        const clean = playlistName(name)
        const { playlist } = await requirePlaylist(playlistId)
        return commit(
          dryRun,
          { playlistId, name: { from: playlist.name, to: clean } },
          {
            targets: [{ kind: 'playlist', entityId: playlistId, field: 'name' }],
            apply: () => playlists.rename(playlistId, clean)
          }
        )
      })
  )

  const reorder = server.registerTool(
    'reorder_playlists',
    {
      title: 'Reorder playlists',
      description:
        'Move one playlist to a new place in the playlist rail; 0 is first, and an index past ' +
        `the end means last. ${DRY_RUN_NOTE}`,
      inputSchema: z
        .object({ playlistId: idInput, toIndex: z.number().int().min(0), dryRun: dryRunInput })
        .strict(),
      annotations: WRITE
    },
    ({ playlistId, toIndex, dryRun }) =>
      organizeGuarded(async () => {
        const { index, count } = await requirePlaylist(playlistId)
        const to = Math.min(toIndex, count - 1)
        return commit(
          dryRun,
          { playlistId, position: { from: index, to } },
          {
            // Only the moved playlist: moving it back is the exact inverse,
            // where restoring every shifted neighbour one by one is not.
            targets: [{ kind: 'playlist', entityId: playlistId, field: 'position' }],
            apply: () => playlists.reorder(playlistId, to)
          }
        )
      })
  )

  const add = server.registerTool(
    'add_to_playlist',
    {
      title: 'Add to playlist',
      description:
        'Add tracks to a playlist as one block, in the order given; a track may appear more than ' +
        'once. `insertion` defaults to the end. Returns the new entries’ ids. On a smart ' +
        'playlist, tracks the operator excluded are skipped and listed in `skipped`, and the ' +
        `add marks the playlist refreshed. ${CAP_NOTE} ${DRY_RUN_NOTE}`,
      inputSchema: z
        .object({
          playlistId: idInput,
          trackIds: idBatch,
          insertion: insertionInput.optional(),
          dryRun: dryRunInput
        })
        .strict(),
      annotations: WRITE
    },
    ({ playlistId, trackIds, insertion, dryRun }) =>
      organizeGuarded(async () => {
        assertWithinCap(trackIds.length, 'tracks')
        const { playlist } = await requirePlaylist(playlistId)
        requireTracks(trackIds)
        const where = insertion ?? { at: 'end' as const }
        const entries = reads.entries(playlistId)
        const at = insertionIndex(
          entries.map((entry) => entry.entryId),
          where
        )
        // D36.8: the service skips these too; planning them here is what lets
        // the diff (and a dry run) say which.
        const excluded =
          playlist.kind === 'smart' ? reads.excluded(playlistId, trackIds) : new Set<number>()
        const adding = trackIds.filter((id) => !excluded.has(id))
        const skipped = [...new Set(trackIds.filter((id) => excluded.has(id)))]
        const diff = {
          playlistId,
          added: adding.length,
          ...(skipped.length > 0 ? { skipped: { excluded: skipped } } : {}),
          at,
          entries: { before: entries.length, after: entries.length + adding.length }
        }
        if (adding.length === 0) {
          return jsonResult({ dryRun: dryRun === true, ...diff, entryIds: [] })
        }
        return commit(
          dryRun,
          diff,
          {
            targets: [entriesTarget(playlistId)],
            apply: () =>
              playlists.addTracks(
                { playlistId, trackIds: adding, insertion: where },
                { actor: 'agent' }
              )
          },
          () => ({
            entryIds: reads
              .entries(playlistId)
              .slice(at, at + adding.length)
              .map((entry) => entry.entryId)
          })
        )
      })
  )

  const move = server.registerTool(
    'move_playlist_entries',
    {
      title: 'Move playlist entries',
      description:
        'Move entries (by `entryId` from get_playlist) to one place in their playlist. They land ' +
        'as one block in the order they already had in the playlist, not the order listed; to ' +
        `set an exact order use set_playlist_order. ${CAP_NOTE} ${DRY_RUN_NOTE}`,
      inputSchema: z
        .object({
          playlistId: idInput,
          entryIds: idBatch,
          insertion: insertionInput,
          dryRun: dryRunInput
        })
        .strict(),
      annotations: WRITE
    },
    ({ playlistId, entryIds, insertion, dryRun }) =>
      organizeGuarded(async () => {
        assertWithinCap(entryIds.length, 'entries')
        await requirePlaylist(playlistId)
        const plan = planMove(reads.entries(playlistId), entryIds, insertion)
        return commit(
          dryRun,
          { playlistId, moved: plan.at === null ? 0 : entryIds.length, at: plan.at },
          {
            targets: [entriesTarget(playlistId)],
            apply: () => playlists.moveEntries({ playlistId, entryIds, insertion })
          }
        )
      })
  )

  const remove = server.registerTool(
    'remove_playlist_entries',
    {
      title: 'Remove playlist entries',
      description:
        'Remove entries (by `entryId` from get_playlist) from a playlist. The tracks stay in the ' +
        'library. On a smart playlist, `exclude: true` also keeps each removed track out of ' +
        'later refreshes — use it when the operator asked for a track to stay out. ' +
        `${CAP_NOTE} ${DRY_RUN_NOTE}`,
      inputSchema: z
        .object({
          playlistId: idInput,
          entryIds: idBatch,
          exclude: z
            .boolean()
            .optional()
            .describe('Smart playlists only: keep the removed tracks out of later refreshes.'),
          dryRun: dryRunInput
        })
        .strict(),
      annotations: REMOVES
    },
    ({ playlistId, entryIds, exclude, dryRun }) =>
      organizeGuarded(async () => {
        assertWithinCap(entryIds.length, 'entries')
        const { playlist } = await requirePlaylist(playlistId)
        if (exclude === true && playlist.kind !== 'smart') {
          throw new ToolInputError('`exclude` applies to smart playlists only; this one is static.')
        }
        const entries = reads.entries(playlistId)
        assertEntriesInPlaylist(entries, entryIds)
        const removing = new Set(entryIds)
        const removed = entries.filter((entry) => removing.has(entry.entryId))
        // A track another entry still names stays in, so it is not excluded.
        const remaining = new Set(
          entries.filter((entry) => !removing.has(entry.entryId)).map((entry) => entry.trackId)
        )
        const excluding =
          exclude === true
            ? [...new Set(removed.map((entry) => entry.trackId))].filter(
                (trackId) => !remaining.has(trackId)
              )
            : []
        return commit(
          dryRun,
          {
            playlistId,
            removed: removed.map((entry) => ({ entryId: entry.entryId, trackId: entry.trackId })),
            ...(exclude === true ? { excluded: excluding } : {}),
            entries: { before: entries.length, after: entries.length - removing.size }
          },
          {
            targets:
              exclude === true
                ? [entriesTarget(playlistId), exclusionsTarget(playlistId)]
                : [entriesTarget(playlistId)],
            apply: () =>
              playlists.removeEntries(
                { playlistId, entryIds },
                { actor: 'agent', exclude: exclude === true }
              )
          }
        )
      })
  )

  const setOrder = server.registerTool(
    'set_playlist_order',
    {
      title: 'Set playlist order',
      description:
        'Put a playlist’s entries in exactly this order: `entryIds` must list every entry of the ' +
        'playlist once (from get_playlist). Entries keep their ids. For a playlist of more than ' +
        `${MAX_ORGANIZE_BATCH} entries use move_playlist_entries. ${DRY_RUN_NOTE}`,
      inputSchema: z
        .object({ playlistId: idInput, entryIds: idBatch, dryRun: dryRunInput })
        .strict(),
      annotations: WRITE
    },
    ({ playlistId, entryIds, dryRun }) =>
      organizeGuarded(async () => {
        assertWithinCap(entryIds.length, 'entries')
        await requirePlaylist(playlistId)
        const entries = reads.entries(playlistId)
        if (entries.length > MAX_ORGANIZE_BATCH) {
          throw new ToolInputError(
            `This playlist has ${entries.length} entries, over the ${MAX_ORGANIZE_BATCH} a whole ` +
              'order may name. Reorder it in blocks with move_playlist_entries instead.'
          )
        }
        const moves = planOrder(entries, entryIds)
        return commit(
          dryRun,
          { playlistId, moved: moves.length, unchanged: entries.length - moves.length },
          {
            targets: [entriesTarget(playlistId)],
            apply: async () => {
              for (const step of moves) {
                await playlists.moveEntries({
                  playlistId,
                  entryIds: [step.entryId],
                  insertion: step.insertion
                })
              }
              const landed = reads.entries(playlistId).map((entry) => entry.entryId)
              if (landed.some((id, i) => id !== entryIds[i])) {
                // Rolls the whole call back with the journal's transaction.
                throw new Error('set_playlist_order did not land on the requested order.')
              }
            }
          }
        )
      })
  )

  const addTag = server.registerTool(
    'add_user_tag',
    {
      title: 'Add user tag',
      description:
        'Apply one of the operator’s own tags (Oscine’s user tags, not the file’s genre) to ' +
        'tracks, coining the tag if it is new. Tags match case-insensitively. Nothing is written ' +
        `to any file. ${CAP_NOTE} ${DRY_RUN_NOTE}`,
      inputSchema: z.object({ trackIds: idBatch, label: labelInput, dryRun: dryRunInput }).strict(),
      annotations: WRITE
    },
    ({ trackIds, label, dryRun }) =>
      organizeGuarded(async () => {
        assertWithinCap(trackIds.length, 'tracks')
        const norm = tagLabel(label)
        requireTracks(trackIds)
        const ids = [...new Set(trackIds)]
        const existing = reads.tagByKey(norm.key)
        const carrying =
          existing === null ? new Set<number>() : reads.tracksWithTag(existing.id, ids)
        return commit(
          dryRun,
          {
            tag: existing?.label ?? norm.label,
            newTag: existing === null,
            added: ids.length - carrying.size,
            alreadyTagged: carrying.size
          },
          {
            targets: ids.map(tagsTarget),
            apply: async () => tags.addTag(ids, norm.label, 'user')
          }
        )
      })
  )

  const removeTag = server.registerTool(
    'remove_user_tag',
    {
      title: 'Remove user tag',
      description:
        'Take one of the operator’s own tags off tracks; a tag left on no track leaves the ' +
        `vocabulary. Tags match case-insensitively. ${CAP_NOTE} ${DRY_RUN_NOTE}`,
      inputSchema: z.object({ trackIds: idBatch, label: labelInput, dryRun: dryRunInput }).strict(),
      annotations: REMOVES
    },
    ({ trackIds, label, dryRun }) =>
      organizeGuarded(async () => {
        assertWithinCap(trackIds.length, 'tracks')
        const norm = tagLabel(label)
        const tag = reads.tagByKey(norm.key)
        if (tag === null) {
          throw new ToolInputError(`No tag is called “${norm.label}”.`)
        }
        const ids = [...new Set(trackIds)]
        const carrying = [...reads.tracksWithTag(tag.id, ids)]
        return commit(
          dryRun,
          { tag: tag.label, removed: carrying.length, notTagged: ids.length - carrying.length },
          {
            targets: carrying.map(tagsTarget),
            apply: async () => tags.removeTag(carrying, tag.id)
          }
        )
      })
  )

  const setSmart = server.registerTool(
    'set_smart_playlist',
    {
      title: 'Set smart playlist',
      description:
        'Mark a playlist `smart` (one the operator wants kept up to date on request) or ' +
        '`static`, and/or set its `brief`: the operator’s plain-language description of what ' +
        'belongs. The brief is the operator’s; write one only when they asked you to create or ' +
        'describe a smart playlist, and an empty brief clears it. Making a playlist static keeps ' +
        `its brief, notes and exclusions. ${DRY_RUN_NOTE} ${DATA_NOTE}`,
      inputSchema: z
        .object({
          playlistId: idInput,
          kind: z.enum(PLAYLIST_KINDS).optional(),
          brief: z
            .string()
            .max(MAX_PLAYLIST_BRIEF_LENGTH * 2)
            .nullable()
            .optional(),
          dryRun: dryRunInput
        })
        .strict(),
      annotations: WRITE
    },
    ({ playlistId, kind, brief, dryRun }) =>
      organizeGuarded(async () => {
        if (kind === undefined && brief === undefined) {
          throw new ToolInputError('Give `kind`, `brief`, or both.')
        }
        const { playlist } = await requirePlaylist(playlistId)
        const nextBrief =
          brief === undefined ? undefined : freeText(brief, 'A brief', MAX_PLAYLIST_BRIEF_LENGTH)
        const kindChanges = kind !== undefined && kind !== playlist.kind
        const briefChanges = nextBrief !== undefined && nextBrief !== playlist.brief
        const targets: JournalTarget[] = [
          ...(kindChanges
            ? [{ kind: 'playlist' as const, entityId: playlistId, field: 'kind' }]
            : []),
          ...(briefChanges
            ? [{ kind: 'playlist' as const, entityId: playlistId, field: 'brief' }]
            : [])
        ]
        const diff = {
          playlistId,
          ...(kindChanges ? { kind: { from: playlist.kind, to: kind } } : {}),
          ...(briefChanges ? { brief: { from: playlist.brief, to: nextBrief } } : {})
        }
        if (targets.length === 0) {
          return jsonResult({ dryRun: dryRun === true, ...diff, unchanged: true })
        }
        return commit(dryRun, diff, {
          targets,
          apply: async () => {
            if (kindChanges) await playlists.setKind(playlistId, kind)
            if (briefChanges) await playlists.setBrief(playlistId, nextBrief)
          }
        })
      })
  )

  const notes = server.registerTool(
    'update_agent_notes',
    {
      title: 'Update agent notes',
      description:
        'Replace a smart playlist’s `agentNotes`: your scratch for whichever agent refreshes it ' +
        'next — the query you used, what you ruled out and why, a one-line summary of this ' +
        'refresh. Write it at the end of every refresh, even one that added nothing: it marks ' +
        `the playlist refreshed. At most ${MAX_PLAYLIST_AGENT_NOTES_LENGTH} characters; empty ` +
        `clears it. ${DRY_RUN_NOTE}`,
      inputSchema: z
        .object({
          playlistId: idInput,
          notes: z.string().max(MAX_PLAYLIST_AGENT_NOTES_LENGTH * 2),
          dryRun: dryRunInput
        })
        .strict(),
      annotations: WRITE
    },
    ({ playlistId, notes: raw, dryRun }) =>
      organizeGuarded(async () => {
        const { playlist } = await requirePlaylist(playlistId)
        if (playlist.kind !== 'smart') {
          throw new ToolInputError(
            'Agent notes belong to smart playlists, and this one is static. Ask the operator ' +
              'before making it smart with set_smart_playlist.'
          )
        }
        const next = freeText(raw, 'Agent notes', MAX_PLAYLIST_AGENT_NOTES_LENGTH)
        return commit(
          dryRun,
          { playlistId, agentNotes: { from: playlist.agentNotes, to: next } },
          {
            targets: [{ kind: 'playlist', entityId: playlistId, field: 'agentNotes' }],
            apply: () => playlists.setAgentNotes(playlistId, next)
          }
        )
      })
  )

  return [create, rename, reorder, add, move, remove, setOrder, addTag, removeTag, setSmart, notes]
}
