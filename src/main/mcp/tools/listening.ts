import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PLAY_HISTORY_CAP } from '@shared/history'
import { MAX_STATS_ROWS, STATS_DIMENSIONS, STATS_SORTS, type StatsRange } from '@shared/stats'
import type { PlayHistoryService } from '../../history/service'
import type { StatsService } from '../../stats/service'
import {
  cursorInput,
  DATA_NOTE,
  decodeCursor,
  guarded,
  instantInput,
  isoOrNull,
  jsonResult,
  limitInput,
  nextCursor,
  parseInstant,
  READ_ONLY,
  ToolInputError
} from './common'

/** What the listening tools need: D17's queries and the recent-plays list. */
export interface ListeningReadDeps {
  stats: Pick<StatsService, 'query' | 'summary'>
  history: Pick<PlayHistoryService, 'list'>
}

const rangeInput = {
  from: instantInput.optional().describe('Start, inclusive. Omit for the start of the log.'),
  to: instantInput.optional().describe('End, inclusive; a bare date includes that whole day.')
}

function toRange(from: string | undefined, to: string | undefined): StatsRange {
  const range = {
    from: from === undefined ? 0 : parseInstant(from, 'start'),
    to: to === undefined ? Number.MAX_SAFE_INTEGER : parseInstant(to, 'end')
  }
  if (range.to < range.from) throw new ToolInputError('`to` is before `from`.')
  return range
}

const minutes = (ms: number): number => Math.round(ms / 6000) / 10

const TOP_DEFAULT = 20

/**
 * `top_listened`, `listening_summary` and `recent_plays` — **W24-4**, D36.4,
 * over the D17 stats engine and the recent-plays list.
 *
 * D17 counts from the listens log's snapshot columns, so a track deleted since,
 * or retagged since, still counts under the name it was played as. The
 * descriptions say so, because an agent comparing these names with `find_tracks`
 * will otherwise think it has found a bug.
 */
export function registerListeningTools(
  server: McpServer,
  deps: ListeningReadDeps
): RegisteredTool[] {
  const top = server.registerTool(
    'top_listened',
    {
      title: 'Top listened',
      description:
        'The most listened tracks, albums, artists or genres over a date range (UTC), with ' +
        'listen counts and minutes listened; sort by `listens` (default) or `time`. Names are ' +
        'as they were when played, so a later retag or a deleted track does not change ' +
        'history; `trackId` is null when no matching track remains. Pages of up to ' +
        `${MAX_STATS_ROWS} with a cursor. Read-only. ${DATA_NOTE}`,
      inputSchema: z
        .object({
          dimension: z.enum(STATS_DIMENSIONS),
          ...rangeInput,
          sort: z.enum(STATS_SORTS).optional(),
          limit: limitInput(MAX_STATS_ROWS, TOP_DEFAULT),
          cursor: cursorInput
        })
        .strict(),
      annotations: READ_ONLY
    },
    (input) =>
      guarded(async () => {
        const offset = decodeCursor(input.cursor)
        const range = toRange(input.from, input.to)
        const result = await deps.stats.query({
          range,
          dimension: input.dimension,
          sort: input.sort ?? 'listens',
          limit: input.limit ?? TOP_DEFAULT,
          offset
        })
        return jsonResult({
          dimension: result.dimension,
          from: isoOrNull(range.from),
          to: range.to === Number.MAX_SAFE_INTEGER ? null : isoOrNull(range.to),
          rows: result.rows.map((row, index) => ({
            rank: offset + index + 1,
            label: row.label,
            sublabel: row.sublabel,
            listens: row.listens,
            minutesListened: minutes(row.msListened),
            trackId: row.trackId
          })),
          total: result.total,
          nextCursor: nextCursor(offset, result.rows.length, result.total)
        })
      })
  )

  const summary = server.registerTool(
    'listening_summary',
    {
      title: 'Listening summary',
      description:
        'Totals over a date range (UTC): listens, minutes listened, distinct tracks, ' +
        'artists and albums, and the first and last listen. Read-only.',
      inputSchema: z.object(rangeInput).strict(),
      annotations: READ_ONLY
    },
    (input) =>
      guarded(async () => {
        const result = await deps.stats.summary({
          range: toRange(input.from, input.to),
          scope: null
        })
        return jsonResult({
          listens: result.listens,
          minutesListened: minutes(result.msListened),
          tracks: result.tracks,
          artists: result.artists,
          albums: result.albums,
          firstListenAt: isoOrNull(result.firstListenAt),
          lastListenAt: isoOrNull(result.lastListenAt)
        })
      })
  )

  const recent = server.registerTool(
    'recent_plays',
    {
      title: 'Recent plays',
      description:
        `The most recent plays, newest first (the app keeps the last ${PLAY_HISTORY_CAP}), ` +
        'each with when it started and the track’s id, title, artist and album. For counts ' +
        `over a period use top_listened. Read-only. ${DATA_NOTE}`,
      inputSchema: z.object({ limit: limitInput(100, TOP_DEFAULT) }).strict(),
      annotations: READ_ONLY
    },
    (input) =>
      guarded(async () => {
        const entries = await deps.history.list({ limit: input.limit ?? TOP_DEFAULT })
        return jsonResult({
          plays: entries.map((entry) => ({
            playedAt: isoOrNull(entry.playedAt),
            track: {
              id: entry.track.id,
              title: entry.track.title,
              artist: entry.track.artist,
              album: entry.track.album
            }
          }))
        })
      })
  )

  return [top, summary, recent]
}
