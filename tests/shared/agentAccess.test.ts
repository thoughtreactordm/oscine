import { describe, expect, it } from 'vitest'
import {
  AGENT_ACCESS_OFF,
  AGENT_CAPABILITIES,
  AGENT_SERVER_DEFAULT_PORT,
  agentClientSnippets,
  agentIndicator,
  agentServerUrl,
  type AgentAccessStatus
} from '@shared/agentAccess'
import {
  MCP_CAPABILITY_KEYS,
  MCP_ENABLED_KEY,
  MCP_PORT_KEY,
  SETTINGS_REGISTRY,
  getSetting,
  validateValue
} from '@shared/settings'

/** W24-2: the mcp.* descriptors, the client snippets and the indicator rule. */
describe('agent access settings', () => {
  const mcp = SETTINGS_REGISTRY.filter((descriptor) => descriptor.key.startsWith('mcp.'))

  it('registers the master switch, the port and one key per capability', () => {
    expect(mcp.map((descriptor) => descriptor.key).sort()).toEqual(
      [
        MCP_ENABLED_KEY,
        MCP_PORT_KEY,
        ...AGENT_CAPABILITIES.map((c) => MCP_CAPABILITY_KEYS[c])
      ].sort()
    )
  })

  it('is off by default, on the fixed port, with every capability on once enabled', () => {
    expect(getSetting(MCP_ENABLED_KEY)?.default).toBe(false)
    expect(getSetting(MCP_PORT_KEY)?.default).toBe(AGENT_SERVER_DEFAULT_PORT)
    for (const capability of AGENT_CAPABILITIES) {
      const descriptor = getSetting(MCP_CAPABILITY_KEYS[capability])
      expect(descriptor?.default).toBe(true)
      expect(descriptor?.gatedBy?.key).toBe(MCP_ENABLED_KEY)
    }
  })

  it('is machine-local: no key rides a settings profile', () => {
    for (const descriptor of mcp) {
      expect(descriptor.scope).toBe('durable')
      expect(descriptor.portable).toBe(false)
      expect(descriptor.category).toBe('integrations')
    }
  })

  it('rejects a port outside the user range rather than clamping it', () => {
    const port = getSetting(MCP_PORT_KEY)
    if (!port) throw new Error('missing')
    expect(validateValue(port, 80).notice).not.toBeNull()
    expect(validateValue(port, 70000).notice).not.toBeNull()
    expect(validateValue(port, 3.5).notice).not.toBeNull()
    expect(validateValue(port, 50000)).toMatchObject({ value: 50000, notice: null })
  })
})

describe('agent client snippets', () => {
  const url = agentServerUrl(47318)
  const bridge = { command: '/opt/Oscine/oscine', args: ['/opt/Oscine/resources/mcp/b.cjs'] }
  const snippets = agentClientSnippets(url, 'tok-123', bridge)

  it('builds the Claude Code command with the bearer header', () => {
    expect(snippets.find((s) => s.id === 'claude-code')?.text).toBe(
      'claude mcp add --scope user --transport http oscine http://127.0.0.1:47318/mcp ' +
        '--header "Authorization: Bearer tok-123"'
    )
  })

  it('builds a generic mcpServers block', () => {
    const generic = snippets.find((s) => s.id === 'generic')?.text
    expect(JSON.parse(generic ?? '')).toEqual({
      mcpServers: {
        oscine: {
          type: 'http',
          url: 'http://127.0.0.1:47318/mcp',
          headers: { Authorization: 'Bearer tok-123' }
        }
      }
    })
  })

  it('starts the stdio bridge with the app binary for Claude Desktop', () => {
    const desktop = snippets.find((s) => s.id === 'claude-desktop')?.text
    expect(JSON.parse(desktop ?? '')).toEqual({
      mcpServers: {
        oscine: {
          command: '/opt/Oscine/oscine',
          args: ['/opt/Oscine/resources/mcp/b.cjs'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            OSCINE_MCP_URL: 'http://127.0.0.1:47318/mcp',
            OSCINE_MCP_TOKEN: 'tok-123'
          }
        }
      }
    })
  })

  it('keeps Windows paths intact through the JSON block', () => {
    const windows = {
      command: 'C:\\Program Files\\Oscine\\Oscine.exe',
      args: ['C:\\Program Files\\Oscine\\resources\\mcp\\b.cjs']
    }
    const desktop = agentClientSnippets(url, 't', windows).find((s) => s.id === 'claude-desktop')
    const entry = JSON.parse(desktop?.text ?? '').mcpServers.oscine
    expect(entry.command).toBe(windows.command)
    expect(entry.args).toEqual(windows.args)
  })

  it('leaves Claude Desktop without a block when the bridge cannot be found', () => {
    const desktop = agentClientSnippets(url, 't', null).find((s) => s.id === 'claude-desktop')
    expect(desktop?.text).toBeNull()
    expect(desktop?.hint).toMatch(/could not be located/)
  })
})

describe('agent indicator', () => {
  const listening = (patch: Partial<AgentAccessStatus>): AgentAccessStatus => ({
    ...AGENT_ACCESS_OFF,
    state: 'listening',
    url: agentServerUrl(47318),
    hasToken: true,
    ...patch
  })
  const session = { id: 'a', clientName: 'x', clientVersion: null, connectedAt: 0 }

  it('is dark while off, or listening with nobody connected', () => {
    expect(agentIndicator(null)).toBeNull()
    expect(agentIndicator(AGENT_ACCESS_OFF)).toBeNull()
    expect(agentIndicator(listening({}))).toBeNull()
  })

  it('lights for a session, and marks a write in flight', () => {
    expect(agentIndicator(listening({ sessions: [session] }))).toEqual({
      busy: false,
      sessions: 1
    })
    expect(agentIndicator(listening({ sessions: [session], writesInFlight: 1 }))).toEqual({
      busy: true,
      sessions: 1
    })
  })
})
