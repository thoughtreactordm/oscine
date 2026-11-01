import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  AgentAlbum,
  AgentAlbumQuery,
  AgentArtist,
  AgentArtistQuery,
  Page
} from '../../library/agentReads'
import {
  cursorInput,
  DATA_NOTE,
  DEFAULT_READ_LIMIT,
  decodeCursor,
  guarded,
  idInput,
  jsonResult,
  limitInput,
  MAX_READ_LIMIT,
  nextCursor,
  READ_ONLY,
  textMatchInput
} from './common'

/** What the album and artist listings need from the library. */
export interface CatalogReadDeps {
  findAlbums(query: AgentAlbumQuery): Promise<Page<AgentAlbum>>
  findArtists(query: AgentArtistQuery): Promise<Page<AgentArtist>>
}

/**
 * `list_albums` and `list_artists` — **W24-4**, D36.4.
 */
export function registerCatalogTools(server: McpServer, deps: CatalogReadDeps): RegisteredTool[] {
  const albums = server.registerTool(
    'list_albums',
    {
      title: 'List albums',
      description:
        'Albums with their album artist, year, track count and length, ordered by album ' +
        'artist then title. Filters are optional and combine. An album is a title under one ' +
        'album artist, so a compilation with no album-artist tag shows as one album per ' +
        'performer (find_issues reports those). Pages of up to ' +
        `${MAX_READ_LIMIT} with a cursor. Read-only. ${DATA_NOTE}`,
      inputSchema: z
        .object({
          title: textMatchInput,
          albumArtist: textMatchInput,
          artistId: idInput
            .optional()
            .describe('Albums credited to this artist or with a track by them.'),
          yearMin: z.number().int().optional(),
          yearMax: z.number().int().optional(),
          limit: limitInput(),
          cursor: cursorInput
        })
        .strict(),
      annotations: READ_ONLY
    },
    ({ limit, cursor, ...filter }) =>
      guarded(async () => {
        const offset = decodeCursor(cursor)
        const page = await deps.findAlbums({
          ...filter,
          offset,
          limit: limit ?? DEFAULT_READ_LIMIT
        })
        return jsonResult({
          albums: page.rows,
          total: page.total,
          nextCursor: nextCursor(offset, page.rows.length, page.total)
        })
      })
  )

  const artists = server.registerTool(
    'list_artists',
    {
      title: 'List artists',
      description:
        'Artists in the library by name, with how many tracks they perform and how many ' +
        'albums are credited to them. Names are as tagged: spellings that differ only in case ' +
        'or punctuation are separate artists here (find_issues groups them). Pages of up to ' +
        `${MAX_READ_LIMIT} with a cursor. Read-only. ${DATA_NOTE}`,
      inputSchema: z
        .object({ name: textMatchInput, limit: limitInput(), cursor: cursorInput })
        .strict(),
      annotations: READ_ONLY
    },
    ({ name, limit, cursor }) =>
      guarded(async () => {
        const offset = decodeCursor(cursor)
        const page = await deps.findArtists({ name, offset, limit: limit ?? DEFAULT_READ_LIMIT })
        return jsonResult({
          artists: page.rows,
          total: page.total,
          nextCursor: nextCursor(offset, page.rows.length, page.total)
        })
      })
  )

  return [albums, artists]
}
