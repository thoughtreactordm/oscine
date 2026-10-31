'use strict'

/**
 * Oscine's stdio bridge — **W24-10**, design authority `oscine-mcp` → D36.1.
 *
 * Some MCP clients (Claude Desktop's local config) only launch servers over
 * stdio. This script is that server, and nothing more: it reads JSON-RPC from
 * stdin, one message per line, POSTs each to the app's loopback Streamable
 * HTTP endpoint with the bearer token, and writes whatever comes back (a JSON
 * body or an SSE stream) to stdout, one message per line.
 *
 * It is launched as `ELECTRON_RUN_AS_NODE=1 <oscine binary> <this file>`, so no
 * separate Node install is needed. Under that variable Electron is plain Node:
 * this file never takes the single-instance lock, never opens the database and
 * never loads app code. It has no dependencies on purpose — it is copied into
 * the package as-is by `extraResources` and must run from there.
 *
 * Configuration comes from the environment the client config sets:
 *
 * - `OSCINE_MCP_TOKEN` — the bearer token from Settings → Agent access.
 * - `OSCINE_MCP_URL` — the endpoint; defaults to the fixed default port. Only a
 *   loopback URL is accepted, so the token is never sent off this machine.
 *
 * The app not running, or agent access being off, is answered with a JSON-RPC
 * error naming that, immediately — never a hang. stdout carries only JSON-RPC;
 * diagnostics go to stderr, which clients show in their logs.
 */

const http = require('node:http')
const readline = require('node:readline')

const DEFAULT_URL = 'http://127.0.0.1:47318/mcp'
const PROTOCOL_HEADER = 'mcp-protocol-version'
const SESSION_HEADER = 'mcp-session-id'
/** Loopback refuses at once; this only catches a listener that never answers. */
const CONNECT_TIMEOUT_MS = 5000
/** How long stdin closing waits for answers still on their way. */
const SHUTDOWN_GRACE_MS = 2000

const NOT_RUNNING = 'Oscine is not running or agent access is off'
/** Codes in the implementation-defined server error range (-32000 to -32099). */
const CODE_UNREACHABLE = -32000
const CODE_REFUSED = -32001
const CODE_SESSION_LOST = -32002

function log(message) {
  process.stderr.write(`[oscine-mcp-bridge] ${message}\n`)
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** A loopback http URL, or a reason it is not one. */
function parseEndpoint(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return { error: `OSCINE_MCP_URL is not a URL: ${raw}` }
  }
  if (url.protocol !== 'http:') return { error: 'OSCINE_MCP_URL must be an http:// URL' }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return { error: 'OSCINE_MCP_URL must point at 127.0.0.1; the token never leaves this machine' }
  }
  return { url }
}

const token = process.env.OSCINE_MCP_TOKEN ?? ''
const endpoint = parseEndpoint(process.env.OSCINE_MCP_URL || DEFAULT_URL)
/** Set when the configuration itself is wrong; every request is answered with it. */
const configError = endpoint.error
  ? endpoint.error
  : token.length === 0
    ? 'OSCINE_MCP_TOKEN is not set; copy the Claude Desktop config from Oscine → Settings → Agent access'
    : null
if (configError) log(configError)

let sessionId = null
let protocolVersion = null
/** Whether the server-to-client GET stream has been opened for this session. */
let listening = false
/** Resolves once `initialize` has answered, so nothing races ahead of the session. */
let initialized = Promise.resolve()
const inFlight = new Set()

/** Every request id in a message or batch; notifications and responses have none. */
function requestIds(message) {
  const items = Array.isArray(message) ? message : [message]
  return items
    .filter((item) => item && typeof item === 'object' && 'method' in item && 'id' in item)
    .map((item) => item.id)
}

function answerWithError(message, code, text) {
  const ids = requestIds(message)
  if (ids.length === 0) log(text)
  for (const id of ids) emit({ jsonrpc: '2.0', id, error: { code, message: text } })
}

function isInitialize(message) {
  return !Array.isArray(message) && message && message.method === 'initialize'
}

function headers(extra) {
  const result = { authorization: `Bearer ${token}`, ...extra }
  if (sessionId) result[SESSION_HEADER] = sessionId
  if (protocolVersion) result[PROTOCOL_HEADER] = protocolVersion
  return result
}

/**
 * One HTTP exchange against the endpoint. Resolves with the response, or
 * rejects with a connection error; the connect timeout is lifted once the
 * socket is up, because a tool call may legitimately run for a while.
 */
function send(method, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint.url, { method, headers: headers(extraHeaders) }, (res) =>
      resolve(res)
    )
    req.on('socket', (socket) => {
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error('connect timeout')))
      socket.once('connect', () => socket.setTimeout(0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
  })
}

/** Forward each `data:` event of an SSE stream as one stdout line. */
function pipeEvents(res) {
  return new Promise((resolve, reject) => {
    res.setEncoding('utf8')
    let buffer = ''
    let data = []
    const flush = () => {
      if (data.length === 0) return
      const payload = data.join('\n')
      data = []
      try {
        emitParsed(JSON.parse(payload))
      } catch {
        log(`dropped a non-JSON event: ${payload.slice(0, 200)}`)
      }
    }
    res.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1)
        if (line === '') flush()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        // `event:`, `id:`, `retry:` and comments carry nothing a stdio client needs.
      }
    })
    res.on('end', () => {
      flush()
      resolve()
    })
    res.on('error', reject)
  })
}

function emitParsed(value) {
  for (const item of Array.isArray(value) ? value : [value]) {
    // Only `initialize` answers with a protocol version; later requests carry
    // it back as the transport spec asks.
    const negotiated = item?.result?.protocolVersion
    if (typeof negotiated === 'string') protocolVersion = negotiated
    emit(item)
  }
}

/**
 * Answers for a response that is not a success, worded for the operator: the
 * client shows this text where a tool list would have been.
 */
async function refuse(message, res) {
  const body = await readBody(res).catch(() => '')
  const status = res.statusCode ?? 0
  if (status === 401) {
    answerWithError(
      message,
      CODE_REFUSED,
      'Oscine refused the token. Copy the current config from Oscine → Settings → Agent access.'
    )
  } else if (status === 404 && sessionId) {
    // The app restarted, or the token was regenerated: this session is gone.
    sessionId = null
    listening = false
    answerWithError(
      message,
      CODE_SESSION_LOST,
      'Oscine ended this session (the app restarted or agent access changed). Restart the server in your client.'
    )
  } else {
    let text = `Oscine answered HTTP ${status}`
    try {
      const parsed = JSON.parse(body)
      const detail = parsed?.error?.message ?? parsed?.error
      if (typeof detail === 'string') text = `${text}: ${detail}`
    } catch {
      // Not JSON; the status alone has to do.
    }
    answerWithError(message, CODE_REFUSED, text)
  }
}

async function forward(message, raw) {
  if (configError) return answerWithError(message, CODE_REFUSED, configError)
  let res
  try {
    res = await send(
      'POST',
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      raw
    )
  } catch (error) {
    log(`${NOT_RUNNING} (${error?.code ?? error?.message ?? error})`)
    return answerWithError(message, CODE_UNREACHABLE, NOT_RUNNING)
  }

  const status = res.statusCode ?? 0
  if (status < 200 || status >= 300) return refuse(message, res)

  const assigned = res.headers[SESSION_HEADER]
  if (typeof assigned === 'string' && assigned.length > 0) sessionId = assigned

  if (status === 202) {
    res.resume()
    return
  }
  const type = String(res.headers['content-type'] ?? '')
  if (type.includes('text/event-stream')) {
    await pipeEvents(res)
  } else {
    const body = await readBody(res)
    if (body.trim().length > 0) emitParsed(JSON.parse(body))
  }
}

/**
 * The server's own stream, for messages it sends unprompted — chiefly
 * `notifications/tools/list_changed` when the operator flips a capability
 * (D36.7). Best effort: a server that declines it costs nothing but those.
 */
async function listen() {
  if (listening || !sessionId) return
  listening = true
  try {
    const res = await send('GET', { accept: 'text/event-stream' })
    if (res.statusCode !== 200) {
      res.resume()
      return
    }
    await pipeEvents(res)
  } catch {
    // The app went away; the next request reports it.
  } finally {
    listening = false
  }
}

function handleLine(line) {
  if (line.trim().length === 0) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  const run = async () => {
    if (isInitialize(message)) {
      // A fresh initialize starts a fresh session.
      sessionId = null
      protocolVersion = null
      return forward(message, line)
    }
    await initialized
    await forward(message, line)
    if (!Array.isArray(message) && message?.method === 'notifications/initialized') void listen()
  }

  const task = run().catch((error) => {
    log(`unexpected failure: ${error?.stack ?? error}`)
    answerWithError(
      message,
      CODE_UNREACHABLE,
      `The Oscine bridge failed: ${error?.message ?? error}`
    )
  })
  if (isInitialize(message)) initialized = task
  inFlight.add(task)
  task.finally(() => inFlight.delete(task))
}

/** Give in-flight answers a moment to land, end the session politely, then go. */
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
  ])
  if (sessionId && !configError) {
    try {
      const res = await Promise.race([
        send('DELETE', {}),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 1000))
      ])
      res.resume()
    } catch {
      // The app is gone already; there is nothing left to end.
    }
  }
  process.exit(0)
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', handleLine)
input.on('close', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
