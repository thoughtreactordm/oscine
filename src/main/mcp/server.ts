import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
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
 */
export const MCP_HOST = '127.0.0.1'
export const MCP_PATH = '/mcp'

/** Bounds a request body before it is parsed; tool inputs are small (D36.3). */
export const MCP_MAX_BODY_BYTES = 1024 * 1024

/** A runaway client opening sessions in a loop must not grow this without end. */
export const MCP_MAX_SESSIONS = 16

export interface McpHttpServerOptions {
  /** `0` asks the OS for a free port — tests only; the app passes a fixed one. */
  port: number
  token: string
  /** Builds a fresh, fully registered server for each new session. */
  createServer: () => McpServer
  onError?: (error: unknown) => void
}

export interface McpHttpServer {
  /** Resolves with the bound port; rejects if the port is taken (no fallback). */
  start(): Promise<number>
  /** Ends every session and stops listening. Idempotent. */
  close(): Promise<void>
  sessionCount(): number
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

export function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer {
  const sessions = new Map<string, Session>()
  let http: Server | null = null
  let boundPort = 0
  const report = options.onError ?? ((error: unknown) => console.error('[mcp]', error))

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = checkMcpRequest(req.headers, { port: boundPort, token: options.token })
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
        return session.transport.handleRequest(req, res, body.value)
      }
      if (!isInitializeRequest(body.value)) {
        return sendRpcError(res, 400, -32000, 'No session: send initialize first')
      }
      if (sessions.size >= MCP_MAX_SESSIONS) {
        return sendRpcError(res, 503, -32000, 'Too many open sessions')
      }
      const session = openSession()
      return session.transport.handleRequest(req, res, body.value)
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = sessionId === undefined ? undefined : sessions.get(sessionId)
      if (!session) return sendRpcError(res, 404, -32001, 'Session not found')
      return session.transport.handleRequest(req, res)
    }

    sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET, POST, DELETE' })
  }

  function openSession(): Session {
    const server = options.createServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session)
      }
    })
    const session: Session = { transport, server }
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
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
          resolve(boundPort)
        })
      })
    },

    async close() {
      const server = http
      http = null
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.allSettled(open.map((session) => session.server.close()))
      if (!server) return
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // An SSE stream is a held-open response; without this, close() waits on it.
        server.closeAllConnections()
      })
    },

    sessionCount: () => sessions.size
  }
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
