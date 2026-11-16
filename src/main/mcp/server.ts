import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { AGENT_SERVER_HOST, AGENT_SERVER_PATH, type AgentSession } from '@shared/agentAccess'
import { checkMcpRequest } from './requestGuard'

/**
 * The agent server's HTTP edge — **W24-1**, `oscine-mcp` → D36.1/D36.2.
 *
 * A plain `node:http` server bound to `127.0.0.1` and nothing else, feeding the
 * SDK's Streamable HTTP transport directly rather than through its Express
 * helpers. Every request passes `checkMcpRequest` (Host, Origin, bearer token)
 * before a transport sees a byte of it.
 *
 * Stateful: an `initialize` without a session id opens a session — one
 * transport and one `McpServer`, because the SDK binds a server to exactly one
 * transport — and every later request names it in `mcp-session-id`. Sessions
 * are kept here so W24-2 can end them all when the operator turns access off
 * or regenerates the token, and so D36.10 has something to list.
 *
 * A session ends when its client sends `DELETE`, but most clients never do —
 * an agent CLI exits or is killed and its session would sit here forever,
 * inflating the connected count until `MCP_MAX_SESSIONS` locks everyone out.
 * So a session with no request in flight (an open GET event stream counts as
 * one) that has been quiet for `idleTimeoutMs` is ended by a periodic sweep,
 * and a full table evicts its longest-quiet such session rather than refusing.
 * A client that comes back afterwards gets 404 and, per the spec,
 * re-initializes.
 */
export const MCP_HOST = AGENT_SERVER_HOST
export const MCP_PATH = AGENT_SERVER_PATH

/** Bounds a request body before it is parsed; tool inputs are small (D36.3). */
export const MCP_MAX_BODY_BYTES = 1024 * 1024

/** A runaway client opening sessions in a loop must not grow this without end. */
export const MCP_MAX_SESSIONS = 16

/** How long a session with nothing in flight may stay quiet before it is ended. */
export const MCP_SESSION_IDLE_MS = 10 * 60_000

/** How often idle sessions are looked for. */
export const MCP_SESSION_SWEEP_MS = 60_000

export interface McpHttpServerOptions {
  /** `0` asks the OS for a free port — tests only; the app passes a fixed one. */
  port: number
  token: string
  /** Builds a fresh, fully registered server for each new session. */
  createServer: () => McpServer
  onError?: (error: unknown) => void
  /** A session opened, finished initializing (its client name is now known), or ended. */
  onSessionsChanged?: () => void
  now?: () => number
  /** Defaults to `MCP_SESSION_IDLE_MS`. */
  idleTimeoutMs?: number
  /** Defaults to `MCP_SESSION_SWEEP_MS`. */
  sweepIntervalMs?: number
}

export interface McpHttpServer {
  /** Resolves with the bound port; rejects if the port is taken (no fallback). */
  start(): Promise<number>
  /** Ends every session and stops listening. Idempotent. */
  close(): Promise<void>
  sessionCount(): number
  /** The open sessions with their client names, oldest first (D36.10). */
  sessions(): AgentSession[]
  /** Every open session's server — how a capability change reaches them (D36.7). */
  servers(): McpServer[]
  /**
   * Swap the token and end every open session, keeping the listener. A
   * regenerated token must lock out whoever held the old one at once (D36.1).
   */
  replaceToken(token: string): Promise<void>
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  connectedAt: number
  /** When a request to it last started or finished. */
  lastSeenAt: number
  /** Responses still open — a held GET event stream keeps this above zero. */
  inFlight: number
}

export function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer {
  const sessions = new Map<string, Session>()
  let http: Server | null = null
  let boundPort = 0
  const report = options.onError ?? ((error: unknown) => console.error('[mcp]', error))
  const changed = options.onSessionsChanged ?? (() => {})
  const now = options.now ?? Date.now
  let token = options.token
  const idleTimeoutMs = options.idleTimeoutMs ?? MCP_SESSION_IDLE_MS
  const sweepIntervalMs = options.sweepIntervalMs ?? MCP_SESSION_SWEEP_MS
  let sweepTimer: ReturnType<typeof setInterval> | null = null

  async function endSessions(): Promise<void> {
    const open = [...sessions.values()]
    sessions.clear()
    if (open.length > 0) changed()
    await Promise.allSettled(open.map((session) => session.server.close()))
  }

  /** Ends sessions without a `DELETE`: the server's `onclose` still ends the journal. */
  async function evict(ids: string[]): Promise<void> {
    const ended: Session[] = []
    for (const id of ids) {
      const session = sessions.get(id)
      if (!session) continue
      sessions.delete(id)
      ended.push(session)
    }
    if (ended.length === 0) return
    changed()
    const results = await Promise.allSettled(ended.map((session) => session.server.close()))
    for (const result of results) if (result.status === 'rejected') report(result.reason)
  }

  function sweepIdle(): Promise<void> {
    const t = now()
    const idle = [...sessions.entries()]
      .filter(([, session]) => session.inFlight === 0 && t - session.lastSeenAt >= idleTimeoutMs)
      .map(([id]) => id)
    return evict(idle)
  }

  /** The longest-quiet session with nothing in flight, if there is one. */
  function quietest(): string | undefined {
    let found: [string, Session] | undefined
    for (const entry of sessions) {
      if (entry[1].inFlight > 0) continue
      if (!found || entry[1].lastSeenAt < found[1].lastSeenAt) found = entry
    }
    return found?.[0]
  }

  function route(
    session: Session,
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown
  ): Promise<void> {
    session.inFlight += 1
    session.lastSeenAt = now()
    res.once('close', () => {
      session.inFlight -= 1
      session.lastSeenAt = now()
    })
    return session.transport.handleRequest(req, res, body)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = checkMcpRequest(req.headers, { port: boundPort, token })
    if (refusal) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (refusal.status === 401) headers['www-authenticate'] = 'Bearer'
      return sendJson(res, refusal.status, { error: refusal.message }, headers)
    }
    const url = new URL(req.url ?? '/', `http://${MCP_HOST}`)
    if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: 'Not found' })

    const sessionHeader = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader

    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (!body.ok) return sendRpcError(res, body.status, body.code, body.message)

      if (sessionId !== undefined) {
        const session = sessions.get(sessionId)
        if (!session) return sendRpcError(res, 404, -32001, 'Session not found')
        return route(session, req, res, body.value)
      }
      if (!isInitializeRequest(body.value)) {
        return sendRpcError(res, 400, -32000, 'No session: send initialize first')
      }
      if (sessions.size >= MCP_MAX_SESSIONS) await sweepIdle()
      if (sessions.size >= MCP_MAX_SESSIONS) {
        const id = quietest()
        if (id === undefined) return sendRpcError(res, 503, -32000, 'Too many open sessions')
        await evict([id])
      }
      const session = openSession()
      return route(session, req, res, body.value)
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = sessionId === undefined ? undefined : sessions.get(sessionId)
      if (!session) return sendRpcError(res, 404, -32001, 'Session not found')
      return route(session, req, res)
    }

    sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET, POST, DELETE' })
  }

  function openSession(): Session {
    const server = options.createServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session)
        changed()
      }
    })
    const opened = now()
    const session: Session = {
      transport,
      server,
      connectedAt: opened,
      lastSeenAt: opened,
      inFlight: 0
    }
    transport.onclose = () => {
      const id = transport.sessionId
      if (id !== undefined && sessions.get(id) === session) {
        sessions.delete(id)
        changed()
      }
    }
    // `clientInfo` is read from `initialize`, which the session id is minted
    // during; `initialized` is the first moment the name is certainly there.
    server.server.oninitialized = () => {
      if (transport.sessionId !== undefined && sessions.has(transport.sessionId)) changed()
    }
    // `connect` only wires callbacks and starts a no-op transport; it settles
    // before the request that opened the session is handed over.
    void server.connect(transport).catch(report)
    return session
  }

  return {
    start() {
      if (http) return Promise.resolve(boundPort)
      const server = createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
          report(error)
          if (!res.headersSent) sendRpcError(res, 500, -32603, 'Internal error')
          else res.end()
        })
      })
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port, MCP_HOST, () => {
          server.off('error', reject)
          server.on('error', report)
          boundPort = (server.address() as AddressInfo).port
          http = server
          sweepTimer = setInterval(() => void sweepIdle(), sweepIntervalMs)
          sweepTimer.unref()
          resolve(boundPort)
        })
      })
    },

    async close() {
      const server = http
      http = null
      if (sweepTimer) clearInterval(sweepTimer)
      sweepTimer = null
      await endSessions()
      if (!server) return
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // An SSE stream is a held-open response; without this, close() waits on it.
        server.closeAllConnections()
      })
    },

    sessionCount: () => sessions.size,

    sessions: () =>
      [...sessions.entries()]
        .map(([id, session]): AgentSession => {
          const client = session.server.server.getClientVersion()
          return {
            id,
            clientName: clip(client?.name),
            clientVersion: clip(client?.version),
            connectedAt: session.connectedAt
          }
        })
        .sort((a, b) => a.connectedAt - b.connectedAt),

    servers: () => [...sessions.values()].map((session) => session.server),

    async replaceToken(next) {
      token = next
      await endSessions()
    }
  }
}

/** A client names itself; the UI draws that name, so it is bounded first. */
const CLIENT_LABEL_MAX = 80

function clip(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, CLIENT_LABEL_MAX) : null
}

type BodyResult =
  { ok: true; value: unknown } | { ok: false; status: 400 | 413; code: number; message: string }

async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MCP_MAX_BODY_BYTES) {
      return { ok: false, status: 413, code: -32600, message: 'Request body too large' }
    }
    chunks.push(chunk)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch {
    return { ok: false, status: 400, code: -32700, message: 'Parse error' }
  }
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null })
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
