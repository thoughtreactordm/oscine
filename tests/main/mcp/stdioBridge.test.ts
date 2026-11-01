import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { LibraryOverview } from '@shared/library'
import { agentClientSnippets, agentServerUrl } from '@shared/agentAccess'
import { createAgentMcpServer } from '../../../src/main/mcp'
import { resolveBridgeLaunch } from '../../../src/main/mcp/bridgeLaunch'
import { createMcpHttpServer, type McpHttpServer } from '../../../src/main/mcp/server'
import { overviewOnlyTools } from './fakeTools'

/**
 * The stdio bridge end to end — **W24-10**, `oscine-mcp` → D36.1.
 *
 * The SDK's own stdio client starts the bridge exactly as the Claude Desktop
 * snippet says to — command, args and env lifted out of the generated JSON —
 * against a real loopback server. `process.execPath` stands in for the app
 * binary: under `ELECTRON_RUN_AS_NODE` the packaged binary *is* a Node, and
 * plain Node ignores the variable, so this runs the script the way it ships.
 */
const TOKEN = 'bridge-token'
const REPO = resolve(__dirname, '../../..')

const OVERVIEW: LibraryOverview = {
  tracks: 1,
  albums: 1,
  artists: 1,
  totalDurationMs: 1000,
  totalBytes: 1000,
  formats: [{ codec: 'flac', tracks: 1 }],
  roots: [{ id: 1, name: 'Music', tracks: 1 }],
  coverage: {
    title: 1,
    artist: 1,
    album: 1,
    albumArtist: 1,
    trackNo: 1,
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

interface DesktopEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

/** The Claude Desktop entry, parsed out of the snippet the operator would paste. */
function desktopEntry(url: string, token: string): DesktopEntry {
  const launch = resolveBridgeLaunch({
    isPackaged: false,
    execPath: process.execPath,
    resourcesPath: '',
    appRoot: REPO,
    stableDir: ''
  })
  expect(launch).not.toBeNull()
  const text = agentClientSnippets(url, token, launch).find((s) => s.id === 'claude-desktop')?.text
  if (!text) throw new Error('no Claude Desktop snippet')
  return (JSON.parse(text) as { mcpServers: { oscine: DesktopEntry } }).mcpServers.oscine
}

function clientFor(entry: DesktopEntry): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...(process.env as Record<string, string>), ...entry.env },
    stderr: 'pipe'
  })
  return { client: new Client({ name: 'claude-desktop-stand-in', version: '0' }), transport }
}

/** A loopback port nothing listens on: bound, read, released. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

describe('stdio bridge', () => {
  let http: McpHttpServer
  let port: number

  beforeAll(async () => {
    http = createMcpHttpServer({
      port: 0,
      token: TOKEN,
      createServer: () => createAgentMcpServer(overviewOnlyTools(OVERVIEW), '0.0.0-test')
    })
    port = await http.start()
  })

  afterAll(async () => {
    await http.close()
  })

  it('lists and calls tools through the pasted Claude Desktop config', async () => {
    const { client, transport } = clientFor(desktopEntry(agentServerUrl(port), TOKEN))
    await client.connect(transport)
    try {
      expect(client.getServerVersion()?.name).toBeTruthy()
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toContain('library_overview')
      const result = await client.callTool({ name: 'library_overview', arguments: {} })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual(OVERVIEW)
      expect(http.sessionCount()).toBe(1)
    } finally {
      await client.close()
    }
    // Closing stdin ends the HTTP session too, not just the bridge.
    await expect.poll(() => http.sessionCount(), { timeout: 5000 }).toBe(0)
  }, 20_000)

  it('answers at once with a clear error when Oscine is not running', async () => {
    const closed = await freePort()
    const { client, transport } = clientFor(desktopEntry(agentServerUrl(closed), TOKEN))
    const started = Date.now()
    await expect(client.connect(transport)).rejects.toThrow(
      'Oscine is not running or agent access is off'
    )
    expect(Date.now() - started).toBeLessThan(5000)
    await client.close()
  }, 20_000)

  it('says the token was refused rather than that the app is down', async () => {
    const { client, transport } = clientFor(desktopEntry(agentServerUrl(port), 'stale-token'))
    await expect(client.connect(transport)).rejects.toThrow('Oscine refused the token')
    await client.close()
  }, 20_000)

  it('will not send the token anywhere but loopback', async () => {
    const entry = desktopEntry(agentServerUrl(port), TOKEN)
    entry.env.OSCINE_MCP_URL = 'http://example.com:47318/mcp'
    const { client, transport } = clientFor(entry)
    await expect(client.connect(transport)).rejects.toThrow('must point at 127.0.0.1')
    await client.close()
  }, 20_000)
})
