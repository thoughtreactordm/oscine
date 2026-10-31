import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * The checks every request to the agent server passes before the MCP transport
 * sees it — **W24-1**, design authority `oscine-mcp` → D36.1.
 *
 * Pure over the headers, so the refusals are unit-tested without a socket.
 * Order matters only for which refusal a doubly-wrong request gets; each check
 * stands alone:
 *
 * - **`Host`** must name the loopback listener itself (`127.0.0.1:<port>` or
 *   `localhost:<port>`). A DNS-rebound page reaches the socket with its own
 *   hostname in `Host`, so this is the rebinding defence the transport spec asks
 *   for — the bind address alone is not.
 * - **`Origin`** must be absent. Agents are not browsers and do not send one; a
 *   request that carries any `Origin`, including the opaque `null`, came from a
 *   web page and is refused whatever the origin claims to be.
 * - **`Authorization: Bearer <token>`**, compared in constant time.
 */
export interface McpGuardConfig {
  /** The port actually bound, which is what a legitimate `Host` names. */
  port: number
  token: string
}

export type McpGuardRefusal = { status: 401 | 403 | 421; message: string }

export function checkMcpRequest(
  headers: IncomingHttpHeaders,
  config: McpGuardConfig
): McpGuardRefusal | null {
  if (!isLoopbackHost(headers.host, config.port)) {
    return { status: 421, message: 'Host is not this loopback listener' }
  }
  if (headers.origin !== undefined) {
    return { status: 403, message: 'Browser origins are refused' }
  }
  if (!bearerMatches(headers.authorization, config.token)) {
    return { status: 401, message: 'Missing or wrong bearer token' }
  }
  return null
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const normalized = host.trim().toLowerCase()
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`
}

function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined || token.length === 0) return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization)
  if (!match) return false
  // Hash both sides first: `timingSafeEqual` needs equal lengths, and comparing
  // digests keeps the token's length out of the timing too.
  return timingSafeEqual(digest(match[1]), digest(token))
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
