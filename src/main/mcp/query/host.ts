import type { QueryRequest, QueryResponse, QueryResult } from './protocol'

/**
 * The main-side half of `query_library` — **W24-5**, `oscine-mcp` → D36.4 and
 * D36.4.2, R19.
 *
 * Agent SQL never runs on main's connection: a careless join over 100k tracks
 * there would stall every IPC call. It runs in a separate **process** holding a
 * confined read-only connection (`worker.ts`). A process and not a worker
 * thread, because the deadline has to be able to stop a statement mid-step: a
 * `node:sqlite` step is one native call, which `Worker.terminate()` cannot
 * interrupt (it waits for the call to return, so a runaway cross join would keep
 * a core and the thread forever). Killing a process stops it at once.
 *
 * - **One query at a time**, in arrival order; each gets the whole deadline
 *   from when it starts, not from when it was queued.
 * - **At the deadline** the process is killed and dropped; the next query starts
 *   a fresh one (spawning is tens of milliseconds, and the policy is re-derived).
 * - **Lazy and idle-reaped.** Nothing is spawned until an agent queries, and an
 *   idle process exits after {@link QueryHostOptions.idleMs}.
 */

/** One spawned query process, behind whatever started it. */
export interface QueryProcess {
  send(request: QueryRequest): void
  onMessage(listener: (response: QueryResponse) => void): void
  onExit(listener: () => void): void
  kill(): void
}

export type SpawnQueryProcess = () => QueryProcess

export interface QueryHostOptions {
  spawn: SpawnQueryProcess
  /** Wall-clock budget per statement. */
  timeoutMs?: number
  /** How long an unused process lives. */
  idleMs?: number
}

export interface QueryHost {
  run(sql: string, rowCap: number): Promise<QueryResult>
  /** Kills the process; every later `run` answers `unavailable`. */
  close(): void
}

export const QUERY_TIMEOUT_MS = 10_000
const QUERY_IDLE_MS = 5 * 60_000

const unavailable = (message: string): QueryResult => ({
  ok: false,
  refusal: 'unavailable',
  message
})

export function createQueryHost(options: QueryHostOptions): QueryHost {
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS
  const idleMs = options.idleMs ?? QUERY_IDLE_MS
  let current: QueryProcess | null = null
  let pending: { id: number; settle(result: QueryResult): void } | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let nextId = 1
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  const retire = (target: QueryProcess): void => {
    if (current === target) current = null
    target.kill()
  }

  const settlePending = (result: QueryResult): void => {
    const waiting = pending
    pending = null
    waiting?.settle(result)
  }

  const ensure = (): QueryProcess => {
    if (current) return current
    const spawned = options.spawn()
    spawned.onMessage((response) => {
      if (current !== spawned || pending?.id !== response.id) return
      const { id: _id, ...result } = response
      settlePending(result)
    })
    spawned.onExit(() => {
      if (current !== spawned) return
      current = null
      settlePending(unavailable('The query process stopped unexpectedly. Try the query again.'))
    })
    current = spawned
    return spawned
  }

  const execute = (sql: string, rowCap: number): Promise<QueryResult> => {
    if (closed) return Promise.resolve(unavailable('Agent access is shutting down.'))
    clearIdle()
    let target: QueryProcess
    try {
      target = ensure()
    } catch (error) {
      return Promise.resolve(
        unavailable(
          `The query process could not start: ${error instanceof Error ? error.message : error}`
        )
      )
    }
    const id = nextId++
    return new Promise<QueryResult>((resolve) => {
      const deadline = setTimeout(() => {
        if (pending?.id !== id) return
        pending = null
        retire(target)
        resolve({
          ok: false,
          refusal: 'timeout',
          message:
            `The query ran past ${timeoutMs / 1000} s and was stopped. Narrow it with WHERE, ` +
            'avoid cross joins, or aggregate before joining.'
        })
      }, timeoutMs)
      pending = {
        id,
        settle: (result) => {
          clearTimeout(deadline)
          resolve(result)
        }
      }
      target.send({ id, sql, rowCap })
    }).finally(() => {
      if (closed || !current) return
      const idle = current
      idleTimer = setTimeout(() => retire(idle), idleMs)
      idleTimer.unref?.()
    })
  }

  return {
    run(sql, rowCap) {
      const result = queue.then(() => execute(sql, rowCap))
      queue = result.catch(() => undefined)
      return result
    },
    close() {
      closed = true
      clearIdle()
      settlePending(unavailable('Agent access is shutting down.'))
      if (current) retire(current)
    }
  }
}
