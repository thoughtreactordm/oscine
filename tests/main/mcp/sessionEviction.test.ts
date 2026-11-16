import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { LibraryOverview } from '@shared/library'
import { createAgentMcpServer } from '../../../src/main/mcp'
import {
  createMcpHttpServer,
  MCP_MAX_SESSIONS,
  type McpHttpServer
} from '../../../src/main/mcp/server'
import { overviewOnlyTools } from './fakeTools'

/**
 * Sessions whose client vanished without a `DELETE` — an agent CLI exiting or
 * killed — must stop counting as connected, and must not fill the table until
 * nobody can connect.
 */
const TOKEN = 'test-token'
const IDLE_MS = 60_000

const OVERVIEW: LibraryOverview = {
  tracks: 0,
  albums: 0,
  artists: 0,
  totalDurationMs: 0,
  totalBytes: 0,
  formats: [],
  roots: [],
  coverage: {
    title: 0,
    artist: 0,
    album: 0,
    albumArtist: 0,
    trackNo: 0,
    discNo: 0,
    year: 0,
    genre: 0,
    artwork: 0,
    replayGainTrack: 0,
    replayGainAlbum: 0,
    userTags: 0
  },
  tracksWithCorrections: 0
}

describe('agent MCP session eviction', () => {
  let http: McpHttpServer | null = null
  let clock = 0
  let serversClosed = 0
  const clients: Client[] = []

  async function start(): Promise<number> {
    clock = 1_000_000
    serversClosed = 0
    http = createMcpHttpServer({
      port: 0,
      token: TOKEN,
      now: () => clock,
      idleTimeoutMs: IDLE_MS,
      sweepIntervalMs: 10,
      createServer: () => {
        const server = createAgentMcpServer(overviewOnlyTools(OVERVIEW), '0.0.0-test')
        // Chained after the journal's own `onclose`, which must still run.
        const journalEnd = server.server.onclose
        server.server.onclose = () => {
          journalEnd?.()
          serversClosed += 1
        }
        return server
      }
    })
    return http.start()
  }

  async function connect(port: number, name = 'vitest'): Promise<Client> {
    const client = new Client({ name, version: '0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
    })
    await client.connect(transport)
    clients.push(client)
    return client
  }

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()))
    await http?.close()
    http = null
  })

  it('ends a session whose client went away without a DELETE once it has been quiet', async () => {
    const port = await start()
    const client = await connect(port)
    await client.listTools()
    expect(http!.sessionCount()).toBe(1)

    // Not long enough yet: the sweep leaves it.
    clock += IDLE_MS - 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(http!.sessionCount()).toBe(1)

    // The client vanishes: no terminateSession, just gone.
    await client.close()
    // Let the dropped stream reach the server before time moves on; its close
    // is what counts as the last activity.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(http!.sessionCount()).toBe(1)
    clock += IDLE_MS
    await vi.waitFor(() => expect(http!.sessionCount()).toBe(0))
    expect(serversClosed).toBe(1)
  })

  it('keeps a quiet session that still holds a request open', async () => {
    const port = await start()
    const client = await connect(port)
    // The SDK client holds a GET event stream open once initialized.
    await vi.waitFor(() => expect(http!.sessionCount()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 40))

    clock += IDLE_MS * 10
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(http!.sessionCount()).toBe(1)
    await client.listTools()
  })

  it('evicts the quietest dead session to admit a new one when the table is full', async () => {
    const port = await start()
    for (let i = 0; i < MCP_MAX_SESSIONS; i += 1) {
      const client = await connect(port, `dead-${i}`)
      await client.close()
      clock += 1
    }
    expect(http!.sessionCount()).toBe(MCP_MAX_SESSIONS)

    // Nobody has been quiet for the idle timeout, so only the cap frees room.
    const live = await connect(port, 'live')
    await live.listTools()
    expect(http!.sessionCount()).toBe(MCP_MAX_SESSIONS)
    const names = http!.sessions().map((session) => session.clientName)
    expect(names).not.toContain('dead-0')
    expect(names).toContain('live')
    expect(serversClosed).toBe(1)
  })

  it('still refuses when every session has a request in flight', async () => {
    const port = await start()
    for (let i = 0; i < MCP_MAX_SESSIONS; i += 1) await connect(port, `live-${i}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await expect(connect(port, 'one-too-many')).rejects.toThrow(/Too many open sessions|503/)
    expect(http!.sessionCount()).toBe(MCP_MAX_SESSIONS)
  })
})
