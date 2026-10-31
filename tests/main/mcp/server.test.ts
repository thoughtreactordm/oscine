import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { LibraryOverview } from '@shared/library'
import { createAgentMcpServer } from '../../../src/main/mcp'
import { createMcpHttpServer, type McpHttpServer } from '../../../src/main/mcp/server'
import { overviewOnlyTools } from './fakeTools'

/**
 * The spike end to end over a real socket — **W24-1**: the SDK's own client
 * initialises a session and calls `library_overview`, and the guard's refusals
 * reach the wire before the transport does.
 */
const TOKEN = 'test-token'

const OVERVIEW: LibraryOverview = {
  tracks: 3,
  albums: 2,
  artists: 2,
  totalDurationMs: 600_000,
  totalBytes: 30_000_000,
  formats: [
    { codec: 'flac', tracks: 2 },
    { codec: 'mp3', tracks: 1 }
  ],
  roots: [{ id: 1, name: 'Music', tracks: 3 }],
  coverage: {
    title: 3,
    artist: 3,
    album: 2,
    albumArtist: 2,
    trackNo: 3,
    discNo: 1,
    year: 2,
    genre: 1,
    artwork: 2,
    replayGainTrack: 0,
    replayGainAlbum: 0,
    userTags: 1
  },
  tracksWithCorrections: 1
}

describe('agent MCP server', () => {
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

  function rawPost(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            host: `127.0.0.1:${port}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers
          }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'raw', version: '0' }
          }
        })
      )
    })
  }

  it('lists and calls library_overview through the SDK client', async () => {
    const client = new Client({ name: 'vitest', version: '0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
    })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toContain('library_overview')
      // Every tool today is a read (W24-1, W24-4).
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)

      const result = await client.callTool({ name: 'library_overview', arguments: {} })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual(OVERVIEW)
      expect(http.sessionCount()).toBe(1)
    } finally {
      await transport.terminateSession()
      await client.close()
    }
    expect(http.sessionCount()).toBe(0)
  })

  it('admits the raw initialize the refusal cases are measured against', async () => {
    expect(await rawPost({ authorization: `Bearer ${TOKEN}` })).toBe(200)
  })

  it('refuses a request without the token, or with the wrong one', async () => {
    expect(await rawPost({})).toBe(401)
    expect(await rawPost({ authorization: 'Bearer wrong' })).toBe(401)
  })

  it('refuses a browser Origin even with the token', async () => {
    expect(
      await rawPost({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })
    ).toBe(403)
  })

  it('refuses a foreign Host even with the token', async () => {
    expect(await rawPost({ authorization: `Bearer ${TOKEN}`, host: `evil.example:${port}` })).toBe(
      421
    )
  })

  it('refuses a non-initialize request with no session', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
          }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    })
    expect(status).toBe(400)
  })
})
