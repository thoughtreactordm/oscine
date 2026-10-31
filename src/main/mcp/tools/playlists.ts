import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { PlaylistService } from '../../library/playlists/service'
import {
  cursorInput,
  DATA_NOTE,
  DEFAULT_READ_LIMIT,
  decodeCursor,
  errorResult,
  guarded,
  idInput,
  jsonResult,
  limitInput,
  MAX_READ_LIMIT,
  nextCursor,
  READ_ONLY
} from './common'
import { fieldsInput, resolveFields, type TrackReadDeps } from './tracks'

/** What the playlist tools need: the playlist service's two reads, nothing that writes. */
export type PlaylistReadDeps = Pick<PlaylistService, 'list' | 'listEntries'>

/**
 * `list_playlists` and `get_playlist` — **W24-4**, D36.4.
 *
 * Entries carry their entry id as well as the track's: a playlist can hold one
 * track twice, and the later Organize tools (W24-7) move and remove *entries*.
 */
export function registerPlaylistTools(
  server: McpServer,
  deps: { playlists: PlaylistReadDeps; tracks: Pick<TrackReadDeps, 'getAgentTracks'> }
): RegisteredTool[] {
  const list = server.registerTool(
    'list_playlists',
    {
      title: 'List playlists',
      description:
        'Every playlist in the order the operator arranged them, with its id, name, entry ' +
        `count and last change. Pages of up to ${MAX_READ_LIMIT} with a cursor. Read-only: ` +
        `this tool cannot create, rename or edit a playlist. ${DATA_NOTE}`,
      inputSchema: z.object({ limit: limitInput(), cursor: cursorInput }).strict(),
      annotations: READ_ONLY
    },
    ({ limit, cursor }) =>
      guarded(async () => {
        const offset = decodeCursor(cursor)
        const all = await deps.playlists.list()
        const rows = all.slice(offset, offset + (limit ?? DEFAULT_READ_LIMIT))
        return jsonResult({
          playlists: rows.map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            entries: playlist.trackCount,
            updatedAt: playlist.updatedAt
          })),
          total: all.length,
          nextCursor: nextCursor(offset, rows.length, all.length)
        })
      })
  )

  const get = server.registerTool(
    'get_playlist',
    {
      title: 'Get playlist',
      description:
        'One playlist’s entries in playing order: each entry’s `entryId` (what a later edit ' +
        'targets — the same track can appear twice) and its track, with the fields you ' +
        `choose. Pages of up to ${MAX_READ_LIMIT} (default ${DEFAULT_READ_LIMIT}) with a ` +
        `cursor. Read-only. ${DATA_NOTE}`,
      inputSchema: z
        .object({
          playlistId: idInput,
          fields: fieldsInput,
          limit: limitInput(),
          cursor: cursorInput
        })
        .strict(),
      annotations: READ_ONLY
    },
    ({ playlistId, fields, limit, cursor }) =>
      guarded(async () => {
        const offset = decodeCursor(cursor)
        const playlist = (await deps.playlists.list()).find((entry) => entry.id === playlistId)
        if (!playlist) return errorResult(`No playlist has id ${playlistId}; see list_playlists.`)
        const page = await deps.playlists.listEntries({
          playlistId,
          offset,
          limit: limit ?? DEFAULT_READ_LIMIT
        })
        const tracks = await deps.tracks.getAgentTracks(
          page.entries.map((entry) => entry.track.id),
          resolveFields(fields)
        )
        const byId = new Map(tracks.map((track) => [track.id, track]))
        return jsonResult({
          playlist: { id: playlist.id, name: playlist.name, updatedAt: playlist.updatedAt },
          entries: page.entries.map((entry) => ({
            entryId: entry.id,
            track: byId.get(entry.track.id) ?? { id: entry.track.id }
          })),
          total: page.total,
          nextCursor: nextCursor(offset, page.entries.length, page.total)
        })
      })
  )

  return [list, get]
}
