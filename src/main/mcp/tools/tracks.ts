import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { LIBRARY_COVERAGE_FIELDS } from '@shared/library'
import {
  AGENT_TRACK_FIELDS,
  AGENT_TRACK_SORTS,
  DEFAULT_AGENT_TRACK_FIELDS,
  type AgentTrack,
  type AgentTrackField,
  type AgentTrackFilter,
  type AgentTrackQuery,
  type Page
} from '../../library/agentReads'
import {
  cursorInput,
  DATA_NOTE,
  DEFAULT_READ_LIMIT,
  decodeCursor,
  guarded,
  idInput,
  instantInput,
  jsonResult,
  limitInput,
  MAX_READ_LIMIT,
  nextCursor,
  parseInstant,
  READ_ONLY,
  textMatchInput
} from './common'

/** What the track tools need from the library. */
export interface TrackReadDeps {
  findTracks(query: AgentTrackQuery): Promise<Page<AgentTrack>>
  getAgentTracks(ids: readonly number[], fields: readonly AgentTrackField[]): Promise<AgentTrack[]>
}

export const fieldsInput = z
  .array(z.enum(AGENT_TRACK_FIELDS))
  .max(AGENT_TRACK_FIELDS.length)
  .optional()
  .describe(
    `Fields to return besides id. Default: ${DEFAULT_AGENT_TRACK_FIELDS.join(', ')}. ` +
      '`root` is the library folder’s name and `path` is relative to it (POSIX); no absolute ' +
      'path is ever returned. `genre`, `title`, `artist`, `album`, `albumArtist` and `year` are ' +
      'effective values: a pending correction wins over the file’s tag.'
  )

export function resolveFields(
  fields: readonly AgentTrackField[] | undefined
): readonly AgentTrackField[] {
  return fields && fields.length > 0 ? [...new Set(fields)] : DEFAULT_AGENT_TRACK_FIELDS
}

const coverageField = z.enum(LIBRARY_COVERAGE_FIELDS)
const nonNegative = z.number().nonnegative()

const findTracksInput = z
  .object({
    title: textMatchInput,
    artist: textMatchInput.describe('The track’s own artist.'),
    album: textMatchInput,
    albumArtist: textMatchInput.describe('The artist the album is grouped under.'),
    genre: textMatchInput.describe('The genre string as tagged, delimiters included.'),
    path: textMatchInput.describe('The path relative to its root, with / separators.'),
    root: z.string().max(500).optional().describe('A library root, by name.'),
    codecs: z
      .array(z.string().max(20))
      .max(20)
      .optional()
      .describe('Codecs as library_overview names them, e.g. flac, mp3, aac.'),
    yearMin: z.number().int().optional(),
    yearMax: z.number().int().optional(),
    durationSecMin: nonNegative.optional(),
    durationSecMax: nonNegative.optional(),
    playCountMin: z.number().int().nonnegative().optional(),
    playCountMax: z.number().int().nonnegative().optional(),
    lastPlayedFrom: instantInput.optional(),
    lastPlayedTo: instantInput.optional(),
    favorite: z.boolean().optional(),
    hasCorrections: z
      .boolean()
      .optional()
      .describe('Tracks with a correction not yet written to the file.'),
    userTag: z.string().max(500).optional().describe('A user tag, by label.'),
    albumId: idInput.optional(),
    artistId: idInput.optional().describe('As the track’s artist or its album’s artist.'),
    present: z
      .array(coverageField)
      .max(LIBRARY_COVERAGE_FIELDS.length)
      .optional()
      .describe('Fields that must have a value.'),
    missing: z
      .array(coverageField)
      .max(LIBRARY_COVERAGE_FIELDS.length)
      .optional()
      .describe('Fields that must be empty.'),
    sort: z
      .enum(AGENT_TRACK_SORTS)
      .optional()
      .describe('id (default), mostPlayed, recentlyPlayed, or album order.'),
    fields: fieldsInput,
    limit: limitInput(),
    cursor: cursorInput
  })
  .strict()

type FindTracksInput = z.infer<typeof findTracksInput>

function toFilter(input: FindTracksInput): AgentTrackFilter {
  const {
    sort: _sort,
    fields: _fields,
    limit: _limit,
    cursor: _cursor,
    lastPlayedFrom,
    lastPlayedTo,
    ...rest
  } = input
  return {
    ...rest,
    lastPlayedFrom:
      lastPlayedFrom === undefined ? undefined : parseInstant(lastPlayedFrom, 'start'),
    lastPlayedTo: lastPlayedTo === undefined ? undefined : parseInstant(lastPlayedTo, 'end')
  }
}

/**
 * `find_tracks` and `get_tracks` — **W24-4**, D36.4.
 */
export function registerTrackTools(server: McpServer, deps: TrackReadDeps): RegisteredTool[] {
  const findTracks = server.registerTool(
    'find_tracks',
    {
      title: 'Find tracks',
      description:
        'Tracks matching every filter given, with the fields you choose. Text filters are ' +
        'case-insensitive; `present`/`missing` test whether a field has a value (album artist ' +
        'counts as missing when the file has no album-artist tag, even though the library ' +
        `groups it under the performer). Pages of up to ${MAX_READ_LIMIT} (default ` +
        `${DEFAULT_READ_LIMIT}) with a cursor; \`total\` counts every match. Read-only: ` +
        'changes nothing, reads no file, and cannot return lyrics, comments or other tags the ' +
        `library does not index. ${DATA_NOTE}`,
      inputSchema: findTracksInput,
      annotations: READ_ONLY
    },
    (input) =>
      guarded(async () => {
        const offset = decodeCursor(input.cursor)
        const limit = input.limit ?? DEFAULT_READ_LIMIT
        const page = await deps.findTracks({
          filter: toFilter(input),
          fields: resolveFields(input.fields),
          sort: input.sort ?? 'id',
          offset,
          limit
        })
        return jsonResult({
          tracks: page.rows,
          total: page.total,
          nextCursor: nextCursor(offset, page.rows.length, page.total)
        })
      })
  )

  const getTracks = server.registerTool(
    'get_tracks',
    {
      title: 'Get tracks',
      description:
        `Tracks by id (up to ${MAX_READ_LIMIT}), in the order given, with the fields you ` +
        'choose. Ids that name no track are listed under `missing`. Read-only. ' +
        DATA_NOTE,
      inputSchema: z
        .object({
          ids: z.array(idInput).min(1).max(MAX_READ_LIMIT),
          fields: fieldsInput
        })
        .strict(),
      annotations: READ_ONLY
    },
    (input) =>
      guarded(async () => {
        const tracks = await deps.getAgentTracks(input.ids, resolveFields(input.fields))
        const found = new Set(tracks.map((track) => track.id))
        return jsonResult({
          tracks,
          missing: [...new Set(input.ids)].filter((id) => !found.has(id))
        })
      })
  )

  return [findTracks, getTracks]
}
