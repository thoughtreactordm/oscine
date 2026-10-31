/**
 * Agent access settings — **W24-2**, `oscine-mcp` → D36.1 and D36.7.
 *
 * The master switch, the port, and the three capability switches. Everything
 * else in Settings → Agent access (the token, the client snippets, connected
 * sessions) is not a stored value and lives in the section's island.
 *
 * Every key is `portable: false`, for the Discord keys' reason and a stronger
 * one: a profile that carried `mcp.enabled` to another machine would open a
 * library to agents there without the operator having decided it on that
 * machine. Agent access is a decision made per machine, like its token, which
 * is not a setting at all.
 */

import {
  AGENT_SERVER_DEFAULT_PORT,
  AGENT_SERVER_MAX_PORT,
  AGENT_SERVER_MIN_PORT,
  type AgentCapabilities,
  type AgentCapability
} from '../agentAccess'
import { booleanValue, defineSetting, integerValue, type SettingDescriptor } from './kernel'

export const MCP_ENABLED_KEY = 'mcp.enabled'
export const MCP_PORT_KEY = 'mcp.port'

/** One key per D36.7 capability; the map is how main reads all three. */
export const MCP_CAPABILITY_KEYS: Readonly<Record<AgentCapability, string>> = Object.freeze({
  read: 'mcp.allowRead',
  organize: 'mcp.allowOrganize',
  stage: 'mcp.allowStage'
})

/** Each on by default once the server is (D36.7). */
export const MCP_CAPABILITY_DEFAULTS: AgentCapabilities = Object.freeze({
  read: true,
  organize: true,
  stage: true
})

const MCP_KEYWORDS = ['agent', 'ai', 'mcp', 'model context protocol', 'claude', 'cursor', 'llm']

const GATE = {
  key: MCP_ENABLED_KEY,
  note: 'Turn on “Allow AI agents” above first. Nothing listens while it is off.'
} as const

export const MCP_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<boolean>({
    key: MCP_ENABLED_KEY,
    scope: 'durable',
    portable: false,
    default: false,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'integrations',
    label: 'Allow AI agents',
    help: 'Run a local MCP server so an AI agent on this computer — Claude Code, Claude Desktop, Cursor — can read your library and, with the capabilities below, organize it. Listens on 127.0.0.1 only and requires the token below. Oscine ships no model and makes no AI calls of its own; while this is off, nothing listens.',
    keywords: [...MCP_KEYWORDS, 'server', 'enable', 'access', 'automation'],
    order: 10
  }),
  defineSetting<number>({
    key: MCP_PORT_KEY,
    scope: 'durable',
    portable: false,
    default: AGENT_SERVER_DEFAULT_PORT,
    validate: integerValue({
      min: AGENT_SERVER_MIN_PORT,
      max: AGENT_SERVER_MAX_PORT,
      strict: true
    }),
    control: { kind: 'number', min: AGENT_SERVER_MIN_PORT, max: AGENT_SERVER_MAX_PORT, step: 1 },
    category: 'integrations',
    label: 'Port',
    help: `The loopback port the server listens on (default ${AGENT_SERVER_DEFAULT_PORT}). If another program already uses it, Oscine says so here rather than picking a different one; change this and update your agent’s config to match.`,
    keywords: [...MCP_KEYWORDS, 'port', 'network', 'localhost'],
    order: 20
  }),
  defineSetting<boolean>({
    key: MCP_CAPABILITY_KEYS.read,
    scope: 'durable',
    portable: false,
    default: MCP_CAPABILITY_DEFAULTS.read,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'integrations',
    label: 'Read the library',
    help: 'Let agents search tracks, albums, artists and playlists, read listening stats, and look for tagging problems. Reads never change anything.',
    keywords: [...MCP_KEYWORDS, 'read', 'search', 'query', 'capability'],
    gatedBy: GATE,
    order: 30
  }),
  defineSetting<boolean>({
    key: MCP_CAPABILITY_KEYS.organize,
    scope: 'durable',
    portable: false,
    default: MCP_CAPABILITY_DEFAULTS.organize,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'integrations',
    label: 'Organize playlists and tags',
    help: 'Let agents create and edit playlists, keep smart playlists up to date, and add or remove your own tags. Changes apply at once, like your own edits, and every agent change can be reverted.',
    keywords: [...MCP_KEYWORDS, 'organize', 'playlist', 'tags', 'write', 'capability'],
    gatedBy: GATE,
    order: 40
  }),
  defineSetting<boolean>({
    key: MCP_CAPABILITY_KEYS.stage,
    scope: 'durable',
    portable: false,
    default: MCP_CAPABILITY_DEFAULTS.stage,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'integrations',
    label: 'Stage tag corrections',
    help: 'Let agents propose tag corrections. They are staged like your own and reach your files only when you apply them in the write-back review; an agent can never write a file.',
    keywords: [...MCP_KEYWORDS, 'stage', 'tags', 'corrections', 'writeback', 'capability'],
    gatedBy: GATE,
    order: 50
  })
]
