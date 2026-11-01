import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentCapabilities } from '@shared/agentAccess'
import type { AgentChangesetSummary } from '@shared/agentChangesets'
import { withChangeOrigin } from '../../library/changes'
import { ChangesetNotFoundError, type AgentJournal } from '../journal/journal'
import type { AgentSessionJournal } from '../journal/session'
import {
  cursorInput,
  DATA_NOTE,
  decodeCursor,
  errorResult,
  guarded,
  idInput,
  isoOrNull,
  jsonResult,
  limitInput,
  nextCursor,
  READ_ONLY
} from './common'

/** The longest description `begin_changeset` keeps. Settings draws it. */
export const MAX_CHANGESET_DESCRIPTION = 200

const CHANGESET_PAGE = 20
const MAX_CHANGESET_PAGE = 100

export interface ChangesetToolDeps {
  journal: AgentJournal
  session: AgentSessionJournal
  /** The live switches, so a revert never reaches past what the operator allows. */
  capabilities: () => AgentCapabilities
}

function summary(changeset: AgentChangesetSummary, current: number | null) {
  return {
    id: changeset.id,
    client: changeset.clientName,
    description: changeset.description,
    origin: changeset.origin,
    startedAt: isoOrNull(changeset.startedAt),
    endedAt: isoOrNull(changeset.endedAt),
    open: changeset.id === current,
    changes: changeset.changeCount,
    reverted: changeset.revertedCount
  }
}

/**
 * `begin_changeset`, `list_changesets` and `revert_changeset` — **W24-6**, D36.6.
 *
 * Listed while either write capability (Organize, Stage) is on: with both off
 * there is nothing to journal and nothing an agent may revert.
 */
export function registerChangesetTools(
  server: McpServer,
  deps: ChangesetToolDeps
): RegisteredTool[] {
  const begin = server.registerTool(
    'begin_changeset',
    {
      title: 'Begin changeset',
      description:
        'Start a named changeset for the task you are about to do. Every write you make after ' +
        'this joins it, until you begin another or the session ends, and the operator can revert ' +
        'the whole changeset in one step from Settings. Without one, your writes join one ' +
        'changeset for the session. Describe the task in a few words (“Fix album artists on ' +
        'the Bowie albums”). Writes nothing to the library.',
      inputSchema: z
        .object({
          description: z.string().trim().min(1).max(MAX_CHANGESET_DESCRIPTION)
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    ({ description }) =>
      guarded(async () => {
        const id = deps.session.begin(description)
        return jsonResult({ changesetId: id })
      })
  )

  const list = server.registerTool(
    'list_changesets',
    {
      title: 'List changesets',
      description:
        'Recent agent changesets, newest first: who made each (client name), its description, ' +
        'when, how many changes it recorded and how many have been reverted. `open` marks the ' +
        `one your writes are joining now. Pages with a cursor. ${DATA_NOTE}`,
      inputSchema: z
        .object({ limit: limitInput(MAX_CHANGESET_PAGE, CHANGESET_PAGE), cursor: cursorInput })
        .strict(),
      annotations: READ_ONLY
    },
    ({ limit, cursor }) =>
      guarded(async () => {
        const offset = decodeCursor(cursor)
        const rows = deps.journal.list(limit ?? CHANGESET_PAGE, offset)
        const total = deps.journal.count()
        const current = deps.session.current()
        return jsonResult({
          changesets: rows.map((row) => summary(row, current)),
          total,
          nextCursor: nextCursor(offset, rows.length, total)
        })
      })
  )

  const revert = server.registerTool(
    'revert_changeset',
    {
      title: 'Revert changeset',
      description:
        'Undo a changeset, only when the operator asks you to. Each change goes back to its ' +
        'value before the agent only if it still holds the value the agent left; anything ' +
        'edited since (by the operator or another changeset) is skipped and reported, never ' +
        'overwritten. Changes under a capability that is switched off are skipped too. Returns ' +
        'restored and skipped counts; reverting the same changeset again restores nothing new.',
      inputSchema: z.object({ changesetId: idInput }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    ({ changesetId }) =>
      guarded(async () => {
        const allowed = deps.capabilities()
        try {
          const result = await withChangeOrigin('agent', () =>
            deps.journal.revert(changesetId, { allowed: (capability) => allowed[capability] })
          )
          return jsonResult({ ...result })
        } catch (error) {
          if (error instanceof ChangesetNotFoundError) {
            return errorResult(`${error.message} See list_changesets.`)
          }
          throw error
        }
      })
  )

  return [begin, list, revert]
}
