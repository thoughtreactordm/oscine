import {
  AGENT_CAPABILITIES,
  agentServerUrl,
  type AgentAccessError,
  type AgentAccessState,
  type AgentAccessStatus,
  type AgentCapabilities,
  type AgentCapability,
  type AgentSession
} from '@shared/agentAccess'
import type { SettingsChange } from '@shared/settings/scope'
import { MCP_CAPABILITY_KEYS, MCP_ENABLED_KEY, MCP_PORT_KEY } from '@shared/settings/mcp'
import { CredentialSealingUnavailableError } from '../scrobble/credentials'
import { applyAgentCapabilities, createAgentMcpServer, type AgentToolDeps } from './index'
import { createMcpHttpServer, type McpHttpServer, type McpHttpServerOptions } from './server'
import type { AgentTokenStore } from './tokenStore'

/**
 * Agent access's lifecycle — **W24-2**, `oscine-mcp` → D36.1, D36.7, D36.10.
 *
 * Follows the settings, live, the way presence follows `discord.*`:
 *
 * - **`mcp.enabled` on** ensures a token (generating and sealing one the first
 *   time) and starts the listener on `mcp.port`. **Off** closes the listener and
 *   ends every session. Nothing listens while it is off.
 * - **`mcp.port`** changing while on restarts the listener there. A port already
 *   taken is an `error` status the Settings section shows; no other port is
 *   tried (D36.1).
 * - **A capability** changing flips that capability's tools on every open
 *   session, each of which is told with one `notifications/tools/list_changed`
 *   (D36.7). New sessions start from the current switches.
 *
 * Start and stop are serialized through one chain, so flicking the toggle
 * faster than a socket binds can never leave two listeners, or one that
 * outlived an "off". Every transition is published through `onStatusChanged`.
 */
export interface AgentAccessService {
  status(): AgentAccessStatus
  /** Bring the listener in line with the settings. Resolves once it is. */
  sync(): Promise<AgentAccessStatus>
  /** Route a settings write here; ignores every key that is not `mcp.*`. */
  onSettingsChanged(changes: readonly SettingsChange[]): void
  /** The token, for the operator to copy. Null while off or before one exists. */
  revealToken(): string | null
  /**
   * Replace the token and end every session (D36.1). Throws
   * `CredentialSealingUnavailableError` when there is no keyring to seal with.
   */
  regenerateToken(): Promise<AgentAccessStatus>
  /**
   * Mark an agent write in flight, for the title-bar indicator (D36.10). Call
   * the returned function when it ends; calling it twice is harmless. Every
   * session's journal write wrapper (W24-6) holds it for each write.
   */
  beginWrite(): () => void
  /** Close for good — app quit. Later syncs do nothing. */
  stop(): Promise<void>
}

/** What this needs from settings: a live read. */
export interface AgentAccessSettings {
  get<T>(key: string): T
}

export interface AgentAccessOptions {
  settings: AgentAccessSettings
  tokens: AgentTokenStore
  tools: AgentToolDeps
  version: string
  onStatusChanged?: (status: AgentAccessStatus) => void
  onError?: (error: unknown) => void
  /** Tests substitute a fake listener; the app uses the real one. */
  createHttpServer?: (options: McpHttpServerOptions) => McpHttpServer
}

const LIFECYCLE_KEYS: readonly string[] = [MCP_ENABLED_KEY, MCP_PORT_KEY]
const CAPABILITY_KEYS: readonly string[] = Object.values(MCP_CAPABILITY_KEYS)

export function createAgentAccessService(options: AgentAccessOptions): AgentAccessService {
  const { settings, tokens, tools, version } = options
  const publish = options.onStatusChanged ?? (() => {})
  const report = options.onError ?? ((error: unknown) => console.error('[mcp]', error))
  const createHttp = options.createHttpServer ?? createMcpHttpServer

  let http: McpHttpServer | null = null
  let boundPort: number | null = null
  let state: AgentAccessState = 'off'
  let error: AgentAccessError | null = null
  let writesInFlight = 0
  let stopped = false
  /**
   * Whether a token exists, cached so that a status read never touches the
   * keyring. Unknown until something has had to ask — the first status read
   * after launch with the server off must not be the thing that wakes a slow
   * secret service (see `passwordStore.ts`).
   */
  let hasToken: boolean | null = null
  let chain: Promise<unknown> = Promise.resolve()

  const enabled = (): boolean => settings.get<boolean>(MCP_ENABLED_KEY) === true
  const configuredPort = (): number => settings.get<number>(MCP_PORT_KEY)

  function capabilities(): AgentCapabilities {
    return Object.fromEntries(
      AGENT_CAPABILITIES.map((capability: AgentCapability) => [
        capability,
        settings.get<boolean>(MCP_CAPABILITY_KEYS[capability]) === true
      ])
    ) as AgentCapabilities
  }

  function status(): AgentAccessStatus {
    if (hasToken === null && state !== 'off') hasToken = tokens.read() !== null
    const port = boundPort ?? configuredPort()
    const sessions: readonly AgentSession[] = http?.sessions() ?? []
    return {
      state,
      port,
      url: state === 'listening' ? agentServerUrl(port) : null,
      error,
      sessions,
      writesInFlight,
      hasToken: hasToken === true
    }
  }

  const announce = (): void => publish(status())

  function beginWrite(): () => void {
    writesInFlight += 1
    announce()
    let done = false
    return () => {
      if (done) return
      done = true
      writesInFlight -= 1
      announce()
    }
  }

  async function shutdown(): Promise<void> {
    const closing = http
    http = null
    boundPort = null
    if (closing) await closing.close()
  }

  async function reconcile(): Promise<void> {
    if (stopped || !enabled()) {
      const wasRunning = http !== null || state !== 'off'
      await shutdown()
      state = 'off'
      error = null
      if (wasRunning) announce()
      return
    }

    const port = configuredPort()
    if (http && boundPort === port) return
    await shutdown()

    let token: string
    try {
      token = tokens.ensure()
      hasToken = true
    } catch (cause) {
      state = 'error'
      error =
        cause instanceof CredentialSealingUnavailableError
          ? { kind: 'no-keyring', message: cause.message }
          : { kind: 'failed', message: describe(cause) }
      announce()
      return
    }

    state = 'starting'
    error = null
    announce()

    const server = createHttp({
      port,
      token,
      createServer: () =>
        createAgentMcpServer(tools, version, capabilities(), { capabilities, beginWrite }),
      onSessionsChanged: announce,
      onError: report
    })
    try {
      boundPort = await server.start()
      http = server
      state = 'listening'
    } catch (cause) {
      // The listener never bound, but close it anyway so nothing it allocated
      // outlives this attempt.
      await server.close().catch(report)
      boundPort = null
      state = 'error'
      error = listenError(cause, port)
    }
    // An "off" or a port change may have landed while the socket was binding;
    // the chain runs it next, and it will see this listener and close it.
    announce()
  }

  function schedule(): Promise<AgentAccessStatus> {
    const next = chain.then(reconcile).catch((cause: unknown) => {
      report(cause)
      state = 'error'
      error = { kind: 'failed', message: describe(cause) }
      announce()
    })
    chain = next
    return next.then(status)
  }

  return {
    status,
    sync: schedule,

    onSettingsChanged(changes) {
      if (changes.some((change) => LIFECYCLE_KEYS.includes(change.key))) void schedule()
      if (changes.some((change) => CAPABILITY_KEYS.includes(change.key)) && http) {
        const current = capabilities()
        for (const server of http.servers()) applyAgentCapabilities(server, current)
      }
    },

    revealToken() {
      if (!enabled()) return null
      const token = tokens.read()
      hasToken = token !== null
      return token
    },

    async regenerateToken() {
      // Ordered on the chain so it cannot interleave with a start that is
      // reading the old token.
      const next = chain.then(async () => {
        const token = tokens.regenerate()
        hasToken = true
        if (http) await http.replaceToken(token)
        // A no-keyring error from before may have been the only thing keeping
        // the server off; it now has a token, so try again.
        if (state === 'error') await reconcile()
      })
      chain = next.catch(() => {})
      await next
      announce()
      return status()
    },

    beginWrite,

    async stop() {
      stopped = true
      await schedule()
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function listenError(cause: unknown, port: number): AgentAccessError {
  const code = (cause as { code?: unknown } | null)?.code
  if (code === 'EADDRINUSE') {
    return {
      kind: 'port-in-use',
      message: `Port ${port} is already in use by another program. Choose a different port, or close the program using it.`
    }
  }
  if (code === 'EACCES') {
    return {
      kind: 'failed',
      message: `Oscine is not allowed to listen on port ${port}. Choose a different port.`
    }
  }
  return { kind: 'failed', message: `Could not listen on port ${port}: ${describe(cause)}` }
}
