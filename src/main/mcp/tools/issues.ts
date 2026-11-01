import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  DUPLICATE_DURATION_TOLERANCE_MS,
  ISSUE_CHECKS,
  ISSUE_GROUP_ID_CAP,
  type IssueCheck,
  type IssueGroups,
  type IssueSummary
} from '../../library/agentReads'
import {
  cursorInput,
  DATA_NOTE,
  decodeCursor,
  guarded,
  jsonResult,
  limitInput,
  nextCursor,
  READ_ONLY
} from './common'

/** What `find_issues` needs from the library. */
export interface IssueReadDeps {
  issueSummary(): Promise<IssueSummary>
  findIssues<C extends IssueCheck>(check: C): Promise<IssueGroups[C][]>
}

const ISSUE_CAP = 200
const ISSUE_DEFAULT = 25

/**
 * `find_issues` — **W24-4**, D36.4: the cleanup checks, cheapest in tokens.
 *
 * Without `check` it returns how many groups each check finds; with one, that
 * check's groups, paged. Every group is compact — ids, display text, the one
 * fact that makes it an issue — so the agent can list or fix from it directly.
 */
export function registerIssuesTool(server: McpServer, deps: IssueReadDeps): RegisteredTool {
  return server.registerTool(
    'find_issues',
    {
      title: 'Find issues',
      description:
        'Library cleanup checks, grouped. Omit `check` for a count per check. ' +
        '`missingAlbumArtist`: albums with tracks whose file has no album-artist tag (shown ' +
        'under the performer instead). `yearMismatch`: albums whose tracks carry different ' +
        `years. \`duplicates\`: same artist and title (ignoring case, accents and punctuation) ` +
        `within ${DUPLICATE_DURATION_TOLERANCE_MS / 1000}s of each other's length. ` +
        '`artistVariants`: artist names that differ only in case, punctuation or accents. ' +
        `Groups list up to ${ISSUE_GROUP_ID_CAP} track ids. The album-artist and year checks ` +
        'can only judge files read since Oscine 1.2; `tracksNotRescanned` says how many are ' +
        'not, and an operator Rescan of the library folder fills them. Read-only: reports issues, ' +
        `fixes nothing. ${DATA_NOTE}`,
      inputSchema: z
        .object({
          check: z.enum(ISSUE_CHECKS).optional(),
          limit: limitInput(ISSUE_CAP, ISSUE_DEFAULT),
          cursor: cursorInput
        })
        .strict(),
      annotations: READ_ONLY
    },
    ({ check, limit, cursor }) =>
      guarded(async () => {
        if (check === undefined) {
          return jsonResult({ ...(await deps.issueSummary()) })
        }
        const offset = decodeCursor(cursor)
        const all = await deps.findIssues(check)
        const groups = all.slice(offset, offset + (limit ?? ISSUE_DEFAULT))
        return jsonResult({
          check,
          groups,
          total: all.length,
          nextCursor: nextCursor(offset, groups.length, all.length)
        })
      })
  )
}
