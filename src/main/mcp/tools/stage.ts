import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { OscineError } from '@shared/errors'
import { OVERRIDE_FIELDS, type OverrideField, type OverridePatch } from '@shared/overrides'
import {
  isEditableTagField,
  TAG_FIELDS,
  TAG_LIST_ENTRY_MAX_LENGTH,
  TAG_LIST_MAX_ENTRIES,
  TAG_LONG_TEXT_MAX_LENGTH,
  tagField,
  type TagFieldKey,
  type TagFieldPatch
} from '@shared/tagFields'
import {
  WRITEBACK_CODECS,
  type FieldDiff,
  type PendingWrite,
  type WritebackField
} from '@shared/tagWriteback'
import {
  assertClearOverridesRequest,
  assertRevertTagOverridesRequest,
  assertSetOverridesRequest,
  assertSetTagOverridesRequest
} from '../../ipc/validate'
import type { LibraryService } from '../../library/service'
import type { TagWritebackService } from '../../library/writeback/service'
import type { JournalTarget } from '../journal/journal'
import type { AgentSessionJournal } from '../journal/session'
import { assertWithinCap, listIds } from '../organize/plan'
import type { StageReads } from '../stage/reads'
import {
  cursorInput,
  DATA_NOTE,
  decodeCursor,
  errorResult,
  guarded,
  idInput,
  jsonResult,
  limitInput,
  nextCursor,
  READ_ONLY,
  ToolInputError
} from './common'

/**
 * The Stage corrections capability's tools — **W24-8**, `oscine-mcp` → D36.5,
 * D36.6.
 *
 * An agent's tag correction lands in exactly the layers a manual edit does:
 * grouped fields through `LibraryService.setOverrides` (the `overrides.set`
 * service), registry fields through `setTagOverrides` (`tagOverrides.set`),
 * each validated by the same IPC validators, and every write through the
 * session's journal wrapper (W24-6). Nothing here reaches a file. The flush —
 * `TagWritebackService.apply` — is not a tool and is not reachable from one:
 * these tools are handed `preview` and nothing else of that service, and the
 * operator writes staged corrections from the write-back review.
 *
 * `dryRun` plans from reads (D36.7.1) and the 500-track cap is the Organize
 * tools' (D36.7). Artwork overrides are out of scope: an agent cannot stage a
 * cover (D36.5), so it cannot revert one either.
 */

export interface StageDeps {
  library: Pick<
    LibraryService,
    | 'setOverrides'
    | 'clearOverrides'
    | 'setTagOverrides'
    | 'revertTagOverrides'
    | 'pendingWritebackTrackIds'
  >
  /** The review's diff, and only that: the flush is the operator's. */
  writeback: Pick<TagWritebackService, 'preview'>
  reads: StageReads
}

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const
const REMOVES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const

/** The most change groups one `stage_tag_changes` call carries. */
export const MAX_STAGE_GROUPS = 100

/** `list_staged` reads every listed file fresh, so its pages are small. */
export const MAX_LIST_STAGED_LIMIT = 100
const DEFAULT_LIST_STAGED_LIMIT = 25

const REVIEW_NOTE =
  'Nothing is ever written to a file by this tool or any other: staged corrections show in the ' +
  'app at once and reach files only when the operator opens Tools → Tag write-back, reviews ' +
  'old → new and clicks Apply. When you are done, tell the operator to review them there.'

const DRY_RUN_NOTE =
  'With `dryRun: true` it returns what it would stage and writes nothing. The change joins your ' +
  'open changeset (see begin_changeset), which the operator can revert in one step.'

const OVERRIDE_FIELD_SET: ReadonlySet<string> = new Set(OVERRIDE_FIELDS)

const dryRunInput = z
  .boolean()
  .optional()
  .describe('Return what this call would change, and write nothing.')

const trackBatch = z.array(idInput).min(1).max(5000)

const valueInput = z.union([
  z.string().max(TAG_LONG_TEXT_MAX_LENGTH),
  z.number(),
  z.boolean(),
  z.array(z.string().max(TAG_LIST_ENTRY_MAX_LENGTH)).max(TAG_LIST_MAX_ENTRIES),
  z.null()
])

const changeInput = z
  .object({
    trackIds: trackBatch,
    set: z
      .record(z.string().max(64), valueInput)
      .describe(
        'Field key → value, keys from list_tag_fields. Core fields take a string or an integer ' +
          '(`""` stages an empty tag); extended fields take their kind, and `null` stages ' +
          'removing that tag from the file.'
      )
  })
  .strict()

/** One group's validated patches. */
interface StageGroup {
  trackIds: number[]
  grouped: OverridePatch | null
  registry: TagFieldPatch | null
}

/** A validator's refusal, as the agent's error. */
function validated<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof OscineError) throw new ToolInputError(error.message)
    throw error
  }
}

function parseGroup(trackIds: number[], set: Record<string, unknown>): StageGroup {
  const grouped: Record<string, unknown> = {}
  const registry: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(set)) {
    if (OVERRIDE_FIELD_SET.has(key)) {
      if (value === null) {
        throw new ToolInputError(
          `${key} is a core field: stage "" to empty it, or drop its staged correction with ` +
            'revert_staged.'
        )
      }
      grouped[key] = value
      continue
    }
    const field = tagField(key)
    if (field === undefined) {
      throw new ToolInputError(`"${key}" is not a tag field; see list_tag_fields.`)
    }
    if (!isEditableTagField(field)) {
      throw new ToolInputError(
        field.readOnly
          ? `${key} is read-only: the app computes it itself.`
          : `${key} is held: it does not yet round-trip on every supported format.`
      )
    }
    registry[key] = value
  }
  if (Object.keys(grouped).length === 0 && Object.keys(registry).length === 0) {
    throw new ToolInputError('Each change must set at least one field.')
  }
  return {
    trackIds,
    grouped:
      Object.keys(grouped).length === 0
        ? null
        : validated(() => assertSetOverridesRequest({ trackIds, patch: grouped }).patch),
    registry:
      Object.keys(registry).length === 0
        ? null
        : validated(() => assertSetTagOverridesRequest({ trackIds, patch: registry }).patch)
  }
}

/** A tool body: input errors and a service's own refusals come back as tool errors. */
async function stageGuarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return guarded(async () => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof OscineError) return errorResult(error.message)
      throw error
    }
  })
}

const overrideTarget = (trackId: number, field: OverrideField): JournalTarget => ({
  kind: 'override',
  entityId: trackId,
  field
})

const tagOverrideTarget = (trackId: number, field: TagFieldKey): JournalTarget => ({
  kind: 'tagOverride',
  entityId: trackId,
  field
})

/** A diff's two sides, in the agent's terms. */
function sides<T>(diff: FieldDiff<T>): { current: T | null; staged: T | null } {
  return { current: diff.current, staged: diff.proposed }
}

const GROUPED_SCALARS = [
  'title',
  'artist',
  'albumArtist',
  'album',
  'trackNo',
  'discNo',
  'year'
] as const

/** One pending write as the agent reads it: only the fields that change. */
function stagedRow(pending: PendingWrite): Record<string, unknown> {
  const fields: Array<{ field: WritebackField; current: unknown; staged: unknown }> = []
  for (const key of GROUPED_SCALARS) {
    const diff: FieldDiff<string | number> = pending[key]
    if (diff.changed) fields.push({ field: key, ...sides(diff) })
  }
  if (pending.genres.changed) {
    fields.push({
      field: 'genres',
      current: pending.genres.current.map((genre) => genre.label),
      staged: pending.genres.proposed.map((genre) => genre.label)
    })
  }
  if (pending.artwork.changed) {
    // A cover is the operator's; the agent only learns that one is staged.
    fields.push({
      field: 'artwork',
      current: { present: pending.artwork.current.present },
      staged: { present: pending.artwork.proposed.present }
    })
  }
  for (const [key, diff] of Object.entries(pending.fields)) {
    if (diff?.changed) fields.push({ field: key as TagFieldKey, ...sides(diff) })
  }
  return {
    trackId: pending.trackId,
    fields,
    ...(pending.agent
      ? { agent: { fields: pending.agent.fields, changesetIds: pending.agent.changesetIds } }
      : {})
  }
}

export function registerStageTools(
  server: McpServer,
  deps: StageDeps,
  session: { journal: AgentSessionJournal }
): RegisteredTool[] {
  const { library, writeback, reads } = deps

  function requireTracks(trackIds: readonly number[]): Map<number, { writable: boolean }> {
    const found = reads.tracks(trackIds)
    const missing = [...new Set(trackIds)].filter((id) => !found.has(id))
    if (missing.length > 0) {
      throw new ToolInputError(
        `Tracks ${listIds(missing)} are not in the library; see find_tracks.`
      )
    }
    return found
  }

  const stage = server.registerTool(
    'stage_tag_changes',
    {
      title: 'Stage tag changes',
      description:
        'Stage tag corrections on tracks: one or more changes, each a set of tracks and the ' +
        'field values to give them all. Field keys and value types are list_tag_fields’. ' +
        'Extended fields are only stored in the file, so they are refused on a track whose ' +
        `format write-back cannot write (${WRITEBACK_CODECS.join(', ')}); core fields stage on ` +
        `any track. At most 500 distinct tracks per call; split larger batches. ${REVIEW_NOTE} ` +
        DRY_RUN_NOTE,
      inputSchema: z
        .object({
          changes: z.array(changeInput).min(1).max(MAX_STAGE_GROUPS),
          dryRun: dryRunInput
        })
        .strict(),
      annotations: WRITE
    },
    ({ changes, dryRun }) =>
      stageGuarded(async () => {
        const all = [...new Set(changes.flatMap((change) => change.trackIds))]
        assertWithinCap(all.length, 'tracks')
        const groups = changes.map((change) =>
          parseGroup([...new Set(change.trackIds)], change.set as Record<string, unknown>)
        )
        const tracks = requireTracks(all)
        const unwritable = (ids: readonly number[]): number[] =>
          ids.filter((id) => tracks.get(id)?.writable === false)
        for (const group of groups) {
          if (group.registry === null) continue
          const refused = unwritable(group.trackIds)
          if (refused.length > 0) {
            throw new ToolInputError(
              `Tracks ${listIds(refused)} are in a format write-back cannot write ` +
                `(${WRITEBACK_CODECS.join(', ')}), so an extended field ` +
                `(${Object.keys(group.registry).join(', ')}) could never reach the file. ` +
                'Leave those tracks out of that change.'
            )
          }
        }

        const targets: JournalTarget[] = groups.flatMap((group) =>
          group.trackIds.flatMap((trackId) => [
            ...Object.keys(group.grouped ?? {}).map((field) =>
              overrideTarget(trackId, field as OverrideField)
            ),
            ...Object.keys(group.registry ?? {}).map((field) =>
              tagOverrideTarget(trackId, field as TagFieldKey)
            )
          ])
        )
        const plan = {
          tracks: all.length,
          changes: groups.map((group) => ({
            tracks: group.trackIds.length,
            set: { ...group.grouped, ...group.registry }
          })),
          // Core corrections on these show in the app but can never be written.
          notWritable: unwritable(all),
          review: REVIEW_NOTE
        }
        if (dryRun) return jsonResult({ dryRun: true, ...plan })
        const done = await session.journal.write({
          targets,
          apply: async () => {
            for (const group of groups) {
              if (group.grouped !== null) {
                await library.setOverrides({ trackIds: group.trackIds, patch: group.grouped })
              }
              if (group.registry !== null) {
                await library.setTagOverrides({ trackIds: group.trackIds, patch: group.registry })
              }
            }
          }
        })
        return jsonResult({
          dryRun: false,
          ...plan,
          changesetId: done.changesetId,
          recorded: done.recorded
        })
      })
  )

  const list = server.registerTool(
    'list_staged',
    {
      title: 'List staged corrections',
      description:
        'The pending write-back diff: for each track with a staged correction, each field that ' +
        'would change, with the file’s current value (read fresh) and the staged one. `changeset` ' +
        'narrows it to tracks a changeset staged (`"current"` for your open one); `trackIds` ' +
        'narrows it further. A track whose file already matches its corrections is left out. ' +
        `Pages are small because every file is read. Read-only. ${DATA_NOTE}`,
      inputSchema: z
        .object({
          changeset: z.union([z.literal('current'), idInput]).optional(),
          trackIds: z.array(idInput).min(1).max(5000).optional(),
          limit: limitInput(MAX_LIST_STAGED_LIMIT, DEFAULT_LIST_STAGED_LIMIT),
          cursor: cursorInput
        })
        .strict(),
      annotations: READ_ONLY
    },
    ({ changeset, trackIds, limit, cursor }) =>
      stageGuarded(async () => {
        const offset = decodeCursor(cursor)
        let ids = await library.pendingWritebackTrackIds()
        if (changeset !== undefined) {
          const id = changeset === 'current' ? session.journal.current() : changeset
          const staged = new Set(id === null ? [] : reads.changesetTracks(id))
          ids = ids.filter((trackId) => staged.has(trackId))
        }
        if (trackIds !== undefined) {
          const wanted = new Set(trackIds)
          ids = ids.filter((trackId) => wanted.has(trackId))
        }
        const page = ids.slice(offset, offset + (limit ?? DEFAULT_LIST_STAGED_LIMIT))
        const rows = (await writeback.preview(page)).map(stagedRow)
        return jsonResult({
          total: ids.length,
          rows,
          nextCursor: nextCursor(offset, page.length, ids.length)
        })
      })
  )

  const revert = server.registerTool(
    'revert_staged',
    {
      title: 'Revert staged corrections',
      description:
        'Drop staged corrections on tracks, so each field goes back to what its file holds. ' +
        '`fields` (keys from list_tag_fields) limits it; omitted, every staged tag field on the ' +
        'tracks is dropped. A staged cover is the operator’s and is never touched. Tracks with ' +
        `nothing staged are skipped. At most 500 tracks per call. ${DRY_RUN_NOTE}`,
      inputSchema: z
        .object({
          trackIds: trackBatch,
          fields: z
            .array(z.string().max(64))
            .min(1)
            .max(OVERRIDE_FIELDS.length + TAG_FIELDS.length)
            .optional(),
          dryRun: dryRunInput
        })
        .strict(),
      annotations: REMOVES
    },
    ({ trackIds, fields, dryRun }) =>
      stageGuarded(async () => {
        const ids = [...new Set(trackIds)]
        assertWithinCap(ids.length, 'tracks')
        let onlyGrouped: Set<string> | null = null
        let onlyRegistry: Set<string> | null = null
        if (fields !== undefined) {
          const grouped = fields.filter((field) => OVERRIDE_FIELD_SET.has(field))
          const registry = fields.filter((field) => !OVERRIDE_FIELD_SET.has(field))
          if (grouped.length > 0) {
            validated(() => assertClearOverridesRequest({ trackIds: ids, fields: grouped }))
          }
          if (registry.length > 0) {
            validated(() => assertRevertTagOverridesRequest({ trackIds: ids, fields: registry }))
          }
          onlyGrouped = new Set(grouped)
          onlyRegistry = new Set(registry)
        }
        requireTracks(ids)

        // Field → the tracks it is staged on, so each service call is one field.
        const groupedByField = new Map<OverrideField, number[]>()
        const registryByField = new Map<TagFieldKey, number[]>()
        const push = <K>(map: Map<K, number[]>, key: K, trackId: number): void => {
          const list = map.get(key) ?? []
          list.push(trackId)
          map.set(key, list)
        }
        for (const [trackId, staged] of reads.stagedFields(ids)) {
          for (const field of staged.grouped) {
            if (onlyGrouped === null || onlyGrouped.has(field)) push(groupedByField, field, trackId)
          }
          for (const field of staged.registry) {
            if (onlyRegistry === null || onlyRegistry.has(field)) {
              push(registryByField, field, trackId)
            }
          }
        }
        const targets: JournalTarget[] = [
          ...[...groupedByField].flatMap(([field, tracks]) =>
            tracks.map((trackId) => overrideTarget(trackId, field))
          ),
          ...[...registryByField].flatMap(([field, tracks]) =>
            tracks.map((trackId) => tagOverrideTarget(trackId, field))
          )
        ]
        const byField: Record<string, number> = {}
        for (const [field, tracks] of [...groupedByField, ...registryByField]) {
          byField[field] = tracks.length
        }
        const plan = {
          reverting: targets.length,
          tracks: new Set(targets.map((target) => target.entityId)).size,
          byField
        }
        if (dryRun || targets.length === 0) return jsonResult({ dryRun: dryRun ?? false, ...plan })
        const done = await session.journal.write({
          targets,
          apply: async () => {
            for (const [field, tracks] of groupedByField) {
              await library.clearOverrides({ trackIds: tracks, fields: [field] })
            }
            for (const [field, tracks] of registryByField) {
              await library.revertTagOverrides({ trackIds: tracks, fields: [field] })
            }
          }
        })
        return jsonResult({
          dryRun: false,
          ...plan,
          changesetId: done.changesetId,
          recorded: done.recorded
        })
      })
  )

  return [stage, list, revert]
}
