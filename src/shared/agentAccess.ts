/**
 * Agent access — the shapes main and the renderer share about the local MCP
 * server (**W24-2**, `oscine-mcp` → D36.1, D36.7, D36.10).
 *
 * Status is what the Settings section and the title-bar indicator draw from.
 * The token is deliberately *not* part of it: status is broadcast on every
 * session change, and a secret that rode every broadcast would be one devtools
 * console away from anyone looking. The renderer asks for the token on its own
 * channel when the operator opens the section.
 */

/** Where the server listens. Loopback only, never configurable (D36.1). */
export const AGENT_SERVER_HOST = '127.0.0.1'
export const AGENT_SERVER_PATH = '/mcp'

/** Fixed default port (D36.1): a taken port is an error, never a silent move. */
export const AGENT_SERVER_DEFAULT_PORT = 47318

/** Below this the OS reserves ports for root; a user app has no business there. */
export const AGENT_SERVER_MIN_PORT = 1024
export const AGENT_SERVER_MAX_PORT = 65535

/**
 * The three switches of D36.7, in the order the Settings section lists them.
 *
 * - `read` — every D36.4 read tool.
 * - `organize` — playlists, user tags and smart playlists (D36.5 rows 3–4, D36.8).
 * - `stage` — staging tag corrections for the operator's write-back review.
 */
export const AGENT_CAPABILITIES = ['read', 'organize', 'stage'] as const

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number]

export type AgentCapabilities = Readonly<Record<AgentCapability, boolean>>

/** One connected agent, as the operator sees it (D36.10). */
export interface AgentSession {
  /** The transport's session id — opaque, stable for the session's life. */
  readonly id: string
  /** `clientInfo.name` from `initialize`, or null when the client sent none. */
  readonly clientName: string | null
  readonly clientVersion: string | null
  /** Epoch milliseconds. */
  readonly connectedAt: number
}

/**
 * Why the server is not listening while `mcp.enabled` is on.
 *
 * - `port-in-use` — another process holds `mcp.port`. Shown, never worked
 *   around by picking another port (D36.1).
 * - `no-keyring` — `safeStorage` cannot seal a token here, so there is no token
 *   to check requests against and nothing may listen.
 * - `failed` — anything else the listener threw.
 */
export type AgentAccessErrorKind = 'port-in-use' | 'no-keyring' | 'failed'

export interface AgentAccessError {
  readonly kind: AgentAccessErrorKind
  readonly message: string
}

export type AgentAccessState = 'off' | 'starting' | 'listening' | 'error'

export interface AgentAccessStatus {
  readonly state: AgentAccessState
  /** The port configured (`starting`, `error`) or bound (`listening`). */
  readonly port: number
  /** The endpoint a client connects to, or null unless `listening`. */
  readonly url: string | null
  /** Null unless `state` is `error`. */
  readonly error: AgentAccessError | null
  readonly sessions: readonly AgentSession[]
  /** Agent writes currently executing; lights the title-bar indicator (D36.10). */
  readonly writesInFlight: number
  /** Whether a token has been generated and can be revealed. */
  readonly hasToken: boolean
}

export const AGENT_ACCESS_OFF: AgentAccessStatus = Object.freeze({
  state: 'off',
  port: AGENT_SERVER_DEFAULT_PORT,
  url: null,
  error: null,
  sessions: Object.freeze([]) as readonly AgentSession[],
  writesInFlight: 0,
  hasToken: false
})

export function agentServerUrl(port: number): string {
  return `http://${AGENT_SERVER_HOST}:${port}${AGENT_SERVER_PATH}`
}

/** The name a client registers the server under; also the snippets' key. */
export const AGENT_SERVER_NAME = 'oscine'

export type AgentClientId = 'claude-code' | 'claude-desktop' | 'generic'

/** One ready-to-paste block in Settings → Agent access. */
export interface AgentClientSnippet {
  readonly id: AgentClientId
  readonly label: string
  /** What the operator does with `text`. */
  readonly hint: string
  /**
   * The block itself, or null when this client cannot be configured yet —
   * Claude Desktop needs the W24-10 stdio bridge, which has not shipped.
   */
  readonly text: string | null
}

/**
 * The config blocks for each client kind (D36.10), built from the URL and the
 * token. Pure, so the exact strings are tested rather than eyeballed.
 */
export function agentClientSnippets(url: string, token: string): readonly AgentClientSnippet[] {
  const authorization = `Bearer ${token}`
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      hint: 'Run in a terminal. Adds the server for your user; drop --scope user for one project only.',
      text:
        `claude mcp add --scope user --transport http ${AGENT_SERVER_NAME} ${url} ` +
        `--header "Authorization: ${authorization}"`
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      hint: 'Claude Desktop starts local servers over stdio. It connects through Oscine’s stdio bridge, which arrives in a later update.',
      text: null
    },
    {
      id: 'generic',
      label: 'Other clients',
      hint: 'For clients that take a Streamable HTTP server in an mcpServers JSON block (Cursor and most others).',
      text: JSON.stringify(
        {
          mcpServers: {
            [AGENT_SERVER_NAME]: {
              type: 'http',
              url,
              headers: { Authorization: authorization }
            }
          }
        },
        null,
        2
      )
    }
  ]
}

/**
 * The title-bar indicator's state, or null when it should not draw (D36.10):
 * lit while a session is open, and marked busy while an agent write is running.
 */
export function agentIndicator(
  status: AgentAccessStatus | null
): { busy: boolean; sessions: number } | null {
  if (!status || status.state !== 'listening') return null
  const sessions = status.sessions.length
  const busy = status.writesInFlight > 0
  if (sessions === 0 && !busy) return null
  return { busy, sessions }
}
