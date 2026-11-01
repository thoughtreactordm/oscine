import type { DatabaseSync } from 'node:sqlite'
import { openConfinedConnection } from '../sqlConfinement'
import type { QueryRequest, QueryResponse } from './protocol'
import { runQuery } from './run'

/**
 * The query process — **W24-5**, `oscine-mcp` → D36.4 (D36.4.2 for why it is
 * a process). Its only argument is the library file; its only connection is the
 * confined, read-only `node:sqlite` one, opened once and kept. It answers one
 * request at a time, in order, and holds no other state, so killing it at a
 * deadline loses nothing.
 *
 * Electron's `utilityProcess` gives it `process.parentPort`; the tests fork it
 * with `child_process`, which gives it `process.send`. It speaks to whichever it
 * has.
 */

interface ParentPort {
  on(event: 'message', listener: (event: { data: QueryRequest }) => void): void
  postMessage(message: QueryResponse): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

const reply = (message: QueryResponse): void => {
  if (parentPort) parentPort.postMessage(message)
  else process.send?.(message)
}

const path = process.argv[2]
let db: DatabaseSync | null = null
let openError = 'The query process was started without a library.'
if (path) {
  try {
    db = openConfinedConnection(path)
  } catch (error) {
    openError = `The library could not be opened for queries: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function handle(request: QueryRequest): void {
  if (!db) {
    reply({ id: request.id, ok: false, refusal: 'unavailable', message: openError })
    return
  }
  reply({ id: request.id, ...runQuery(db, request.sql, request.rowCap) })
}

if (parentPort) parentPort.on('message', (event) => handle(event.data))
else process.on('message', (message) => handle(message as QueryRequest))
