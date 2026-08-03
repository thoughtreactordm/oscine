import type Database from 'better-sqlite3'
import {
  LISTEN_FLUSH_TIMEOUT_MS,
  type ListenCommit,
  type RecordListenRequest
} from '@shared/listens'
import { ListenStore } from './store'

/**
 * Everything the IPC layer needs from the listens log, and nothing more.
 *
 * The same seam `PlayHistoryService` draws, plus the two halves of the
 * quit-time flush. Those live here rather than in `main/index.ts` because the
 * handshake is a state machine — request out, answer or timeout back — and one
 * spelled out inline in a `before-quit` handler is one that can only be tested
 * by quitting the app.
 */
export interface ListenService {
  /** Commits one departed listen. Resolves `null` when no row was written. */
  record(request: RecordListenRequest): Promise<ListenCommit | null>
  /**
   * Asks the renderer to depart its in-flight listen, and waits for the answer.
   *
   * Resolves either way, and always within the timeout. A renderer that is gone
   * or wedged at quit is not a reason to keep the app open, and the row it was
   * holding is the documented cost of the one-write design.
   */
  flush(): Promise<void>
  /** The renderer's answer. A no-op when nothing is waiting for it. */
  acknowledgeFlush(): void
}

export interface SqliteListenDeps {
  db: Database.Database
  /**
   * Sends `listens.flushRequested`. Injected rather than reached for, so the
   * service stays Electron-free and the handshake is drivable under plain Node.
   *
   * Omitted means there is nobody to ask — `flush` resolves at once rather than
   * burning the timeout, which is what a headless test wants.
   */
  requestFlush?: () => void
  /** Injectable so a test can assert the timeout without waiting two seconds. */
  flushTimeoutMs?: number
}

export class SqliteListenService implements ListenService {
  private readonly store: ListenStore
  private readonly requestFlush: (() => void) | null
  private readonly flushTimeoutMs: number

  /**
   * The flush in progress, if any.
   *
   * One at a time, and a second caller joins the first rather than sending a
   * second request: `before-quit` can fire more than once, and a renderer that
   * answered the first would leave the second waiting out its whole timeout.
   */
  private pending: { promise: Promise<void>; settle: () => void } | null = null

  constructor(deps: SqliteListenDeps) {
    this.store = new ListenStore(deps.db)
    this.requestFlush = deps.requestFlush ?? null
    this.flushTimeoutMs = Math.max(0, deps.flushTimeoutMs ?? LISTEN_FLUSH_TIMEOUT_MS)
  }

  async record(request: RecordListenRequest): Promise<ListenCommit | null> {
    return this.store.commit(request)
  }

  async flush(): Promise<void> {
    if (this.pending) return this.pending.promise
    if (!this.requestFlush) return

    let settle!: () => void
    const answered = new Promise<void>((resolve) => {
      settle = resolve
    })

    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.flushTimeoutMs)
      // The quit is already under way and this timer is the only thing that
      // could hold the loop open past it. Nothing is waiting on the process
      // staying alive for it to fire.
      timer.unref?.()
    })

    const promise = Promise.race([answered, timedOut]).finally(() => {
      clearTimeout(timer)
      this.pending = null
    })
    this.pending = { promise, settle }

    // After the promise is armed: a `requestFlush` that answered synchronously
    // — which a fake in a test does — must find something to settle.
    this.requestFlush()
    return promise
  }

  acknowledgeFlush(): void {
    this.pending?.settle()
  }
}
