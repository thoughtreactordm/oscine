import { createServer, type Server } from 'node:net'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { LibraryOverview } from '@shared/library'
import type { AgentAccessStatus } from '@shared/agentAccess'
import {
  MCP_CAPABILITY_KEYS,
  MCP_ENABLED_KEY,
  MCP_PORT_KEY,
  MCP_SETTINGS
} from '@shared/settings/mcp'
import { CredentialSealingUnavailableError } from '../../../src/main/scrobble/credentials'
import {
  createAgentAccessService,
  type AgentAccessService
} from '../../../src/main/mcp/agentAccess'
import type { AgentTokenStore } from '../../../src/main/mcp/tokenStore'

/**
 * W24-2's lifecycle over real loopback sockets: toggling `mcp.enabled` starts
 * and stops the listener, nothing listens while off, a taken port is an error
 * rather than a different port, capability switches reach a connected client as
 * `tools/list_changed`, and a regenerated token ends every session.
 */

const OVERVIEW = {
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
} satisfies LibraryOverview

/** A port nothing is on right now: bind to 0, read it, let it go. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Whether anything accepts a TCP connection on the port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function fakeSettings(port: number) {
  const values = new Map<string, unknown>(MCP_SETTINGS.map((d) => [d.key, d.default]))
  values.set(MCP_PORT_KEY, port)
  return {
    values,
    get: <T>(key: string): T => values.get(key) as T
  }
}

function fakeTokens(
  options: { available?: boolean } = {}
): AgentTokenStore & { current: string | null } {
  let n = 0
  const store = {
    current: null as string | null,
    available: () => options.available !== false,
    read: () => store.current,
    ensure: () => {
      if (options.available === false) throw new CredentialSealingUnavailableError()
      store.current ??= `token-${++n}`
      return store.current
    },
    regenerate: () => {
      if (options.available === false) throw new CredentialSealingUnavailableError()
      store.current = `token-${++n}`
      return store.current
    }
  }
  return store
}

const change = (key: string, value: unknown) => [{ key, scope: { kind: 'global' }, value }] as never

async function connectClient(port: number, token: string) {
  const client = new Client({ name: 'vitest-agent', version: '1.2.3' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  return { client, transport }
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('agent access lifecycle', () => {
  const cleanup: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    while (cleanup.length)
      await cleanup
        .pop()?.()
        .catch(() => {})
  })

  function build(port: number, tokens = fakeTokens()) {
    const settings = fakeSettings(port)
    const published: AgentAccessStatus[] = []
    const service: AgentAccessService = createAgentAccessService({
      settings,
      tokens,
      tools: { library: { overview: async () => OVERVIEW } },
      version: '0.0.0-test',
      onStatusChanged: (status) => published.push(status),
      onError: () => {}
    })
    cleanup.push(() => service.stop())
    const set = async (key: string, value: unknown) => {
      settings.values.set(key, value)
      service.onSettingsChanged(change(key, value))
      await service.sync()
    }
    return { service, settings, tokens, published, set }
  }

  it('listens on nothing while mcp.enabled is off — the default', async () => {
    const port = await freePort()
    const { service, tokens } = build(port)
    const status = await service.sync()
    expect(status.state).toBe('off')
    expect(status.url).toBeNull()
    expect(await listening(port)).toBe(false)
    // No token is generated until the operator turns access on.
    expect(tokens.current).toBeNull()
    expect(service.revealToken()).toBeNull()
  })

  it('starts on enable, lists the session by client name, and closes the port on disable', async () => {
    const port = await freePort()
    const { service, set } = build(port)

    await set(MCP_ENABLED_KEY, true)
    const on = service.status()
    expect(on.state).toBe('listening')
    expect(on.url).toBe(`http://127.0.0.1:${port}/mcp`)
    expect(on.hasToken).toBe(true)
    expect(await listening(port)).toBe(true)

    const token = service.revealToken()
    expect(token).toBe('token-1')
    const { client } = await connectClient(port, token as string)
    cleanup.push(() => client.close())
    await waitFor(() => service.status().sessions[0]?.clientName === 'vitest-agent')
    expect(service.status().sessions[0]).toMatchObject({
      clientName: 'vitest-agent',
      clientVersion: '1.2.3'
    })

    await set(MCP_ENABLED_KEY, false)
    const off = service.status()
    expect(off.state).toBe('off')
    expect(off.sessions).toEqual([])
    expect(await listening(port)).toBe(false)
  })

  it('reuses the token across restarts of the listener', async () => {
    const port = await freePort()
    const { service, set } = build(port)
    await set(MCP_ENABLED_KEY, true)
    await set(MCP_ENABLED_KEY, false)
    await set(MCP_ENABLED_KEY, true)
    expect(service.revealToken()).toBe('token-1')
  })

  it('reports a taken port as an error and does not fall back to another', async () => {
    const port = await freePort()
    const squatter: Server = createServer()
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())))

    const { service, set } = build(port)
    await set(MCP_ENABLED_KEY, true)
    const status = service.status()
    expect(status.state).toBe('error')
    expect(status.error?.kind).toBe('port-in-use')
    expect(status.error?.message).toContain(String(port))
    expect(status.port).toBe(port)
    expect(status.url).toBeNull()

    // Freed, a retry takes it.
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
    expect((await service.sync()).state).toBe('listening')
  })

  it('moves to a new port when mcp.port changes while on', async () => {
    const first = await freePort()
    const { service, set } = build(first)
    await set(MCP_ENABLED_KEY, true)
    const second = await freePort()
    await set(MCP_PORT_KEY, second)
    expect(service.status().port).toBe(second)
    expect(await listening(second)).toBe(true)
    expect(await listening(first)).toBe(false)
  })

  it('refuses to listen without a keyring to seal a token with', async () => {
    const port = await freePort()
    const { service, set } = build(port, fakeTokens({ available: false }))
    await set(MCP_ENABLED_KEY, true)
    expect(service.status().state).toBe('error')
    expect(service.status().error?.kind).toBe('no-keyring')
    expect(await listening(port)).toBe(false)
  })

  it('hides a capability’s tools and tells the connected client', async () => {
    const port = await freePort()
    const { service, set } = build(port)
    await set(MCP_ENABLED_KEY, true)
    const { client } = await connectClient(port, service.revealToken() as string)
    cleanup.push(() => client.close())

    let notified = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified += 1
    })
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('library_overview')

    await set(MCP_CAPABILITY_KEYS.read, false)
    await waitFor(() => notified === 1)
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'library_overview'
    )
    const refused = await client.callTool({ name: 'library_overview', arguments: {} })
    expect(refused.isError).toBe(true)

    await set(MCP_CAPABILITY_KEYS.read, true)
    await waitFor(() => notified === 2)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('library_overview')

    // A switch that changes nothing tells nobody.
    await set(MCP_CAPABILITY_KEYS.read, true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(notified).toBe(2)
  })

  it('starts a new session with the capabilities already applied', async () => {
    const port = await freePort()
    const { service, set } = build(port)
    await set(MCP_CAPABILITY_KEYS.read, false)
    await set(MCP_ENABLED_KEY, true)
    const { client } = await connectClient(port, service.revealToken() as string)
    cleanup.push(() => client.close())
    expect((await client.listTools()).tools).toEqual([])
  })

  it('regenerating the token ends every session and locks out the old token', async () => {
    const port = await freePort()
    const { service, set } = build(port)
    await set(MCP_ENABLED_KEY, true)
    const old = service.revealToken() as string
    const { client } = await connectClient(port, old)
    cleanup.push(() => client.close())
    await waitFor(() => service.status().sessions.length === 1)

    const status = await service.regenerateToken()
    expect(status.sessions).toEqual([])
    expect(status.state).toBe('listening')
    const fresh = service.revealToken() as string
    expect(fresh).not.toBe(old)

    await expect(connectClient(port, old)).rejects.toThrow()
    const again = await connectClient(port, fresh)
    cleanup.push(() => again.client.close())
  })

  it('counts writes in flight for the indicator, once per release', async () => {
    const port = await freePort()
    const { service, published } = build(port)
    const release = service.beginWrite()
    expect(service.status().writesInFlight).toBe(1)
    release()
    release()
    expect(service.status().writesInFlight).toBe(0)
    expect(published.map((status) => status.writesInFlight)).toEqual([1, 0])
  })

  it('closes for good on stop', async () => {
    const port = await freePort()
    const { service, set } = build(port)
    await set(MCP_ENABLED_KEY, true)
    await service.stop()
    expect(await listening(port)).toBe(false)
    await service.sync()
    expect(service.status().state).toBe('off')
  })
})
