import type { LibraryOverview } from '@shared/library'
import type { AgentToolDeps } from '../../../src/main/mcp'

/**
 * Tool deps for tests about the server and its lifecycle rather than a tool:
 * only `library_overview` answers, and any other tool that is called fails
 * loudly instead of returning something plausible.
 */
export function overviewOnlyTools(overview: LibraryOverview): AgentToolDeps {
  const unused = (): never => {
    throw new Error('not wired in this test')
  }
  return {
    library: {
      overview: async () => overview,
      findTracks: unused,
      getAgentTracks: unused,
      findAlbums: unused,
      findArtists: unused,
      issueSummary: unused,
      findIssues: unused
    },
    playlists: { list: unused, listEntries: unused },
    stats: { query: unused, summary: unused },
    history: { list: unused },
    query: { run: unused }
  }
}
