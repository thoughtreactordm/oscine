import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { LIBRARY_COVERAGE_FIELDS, type LibraryOverview } from '@shared/library'

/** What the tool needs from the library — the service method, nothing wider. */
export interface LibraryOverviewDeps {
  overview(): Promise<LibraryOverview>
}

const count = z.number().int().nonnegative()

export const libraryOverviewOutput = z.object({
  tracks: count,
  albums: count,
  artists: count,
  totalDurationMs: count,
  totalBytes: count,
  formats: z.array(z.object({ codec: z.string().nullable(), tracks: count })),
  roots: z.array(z.object({ id: count, name: z.string(), tracks: count })),
  coverage: z.object(
    Object.fromEntries(LIBRARY_COVERAGE_FIELDS.map((field) => [field, count])) as Record<
      (typeof LIBRARY_COVERAGE_FIELDS)[number],
      typeof count
    >
  ),
  tracksWithCorrections: count
})

/**
 * `library_overview` — **W24-1**, `oscine-mcp` → D36.4's first structured read.
 *
 * Takes no input. Built on `LibraryService.overview()`, the same service layer
 * IPC calls (D36.3); the tool adds only the schema and the wire shape. Returns
 * the result twice, as the spec asks of a tool with an output schema: as
 * `structuredContent` for clients that read it and as JSON text for those that
 * do not.
 */
export function registerLibraryOverview(
  server: McpServer,
  deps: LibraryOverviewDeps
): RegisteredTool {
  return server.registerTool(
    'library_overview',
    {
      title: 'Library overview',
      description:
        'Counts of tracks, albums and artists; total duration and size; tracks per codec; ' +
        'library roots by name (never by path); and, per indexed field, how many tracks have ' +
        'a non-empty effective value (file tag with any correction applied). Read-only: ' +
        'changes nothing and reads no file.',
      outputSchema: libraryOverviewOutput,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true }
    },
    async () => {
      const overview = await deps.overview()
      return {
        content: [{ type: 'text', text: JSON.stringify(overview) }],
        structuredContent: { ...overview }
      }
    }
  )
}
