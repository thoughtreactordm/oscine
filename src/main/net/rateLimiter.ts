/**
 * A per-host floor on how often Oscine may open a socket.
 *
 * MusicBrainz permits roughly one request per second (**R5**, secondary). A
 * shuffle-heavy session walking twenty artists must therefore not become twenty
 * simultaneous requests, and the drawer-scoping D14 already imposes is only half
 * the answer — it bounds *when* fetching happens, not how fast.
 *
 * ## Why a queue rather than a reserved slot
 *
 * The obvious implementation keeps a `nextAllowedAt` per host and has each
 * caller claim `max(now, nextAllowedAt)` on arrival, bumping the mark as it
 * goes. It spaces requests correctly and it is four lines. It also fails the
 * one behaviour W7-7's acceptance names: open the deck, close it immediately,
 * open it again. Twenty callers claim twenty slots, the close cancels all of
 * them, and the mark now sits twenty seconds in the future — so the second open
 * waits twenty seconds to make its first request, having made none.
 *
 * A FIFO queue that only advances its clock when a caller *actually starts*
 * has no such hole. A cancelled waiter leaves the queue and takes nothing with
 * it, so a cancelled burst costs exactly the requests it did not make.
 *
 * ## Spacing is between starts
 *
 * The interval is measured from one caller being released to the next, not from
 * one response arriving to the next request leaving. A slow reply does not earn
 * the next caller a shorter wait, and — more to the point — it does not earn it
 * a longer one either: two seconds of latency on request three must not push
 * request four two seconds late as well, or a run of slow replies compounds
 * into a stall.
 */

/** Aborting a waiter rejects its `acquire` with this. Never reaches a pane. */
export class RateLimitAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super('Waiting for a rate-limit slot was aborted.')
    this.name = 'RateLimitAbortedError'
  }
}

export interface RateLimiter {
  /**
   * Resolves when the caller may open a socket to `host`.
   *
   * Rejects with `RateLimitAbortedError` if `signal` aborts first, carrying the
   * signal's reason so the caller can tell a cancelled scope from a timeout.
   */
  acquire(host: string, signal?: AbortSignal): Promise<void>
  /** How many callers are waiting. Test and diagnostic use only. */
  waiting(host: string): number
}

export interface RateLimiterOptions {
  /** Minimum milliseconds between two releases for the same host. */
  minIntervalMs: number
  /** Injected so tests need neither fake timers nor real waiting. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Waiter {
  resolve: () => void
  detach: () => void
}

interface HostQueue {
  waiters: Waiter[]
  /** When the most recent caller was released. `-Infinity` before the first. */
  lastReleasedAt: number
  timer: unknown | null
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms)
  // A pending rate-limit wait must never be the reason the main process stays
  // up, for the same reason a pending download must not — see `http.ts`.
  ;(handle as { unref?: () => void }).unref?.()
  return handle
}

export function createRateLimiter({
  minIntervalMs,
  now = Date.now,
  setTimer = defaultSetTimer,
  clearTimer = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}: RateLimiterOptions): RateLimiter {
  const queues = new Map<string, HostQueue>()

  const queueFor = (host: string): HostQueue => {
    let queue = queues.get(host)
    if (!queue) {
      queue = { waiters: [], lastReleasedAt: Number.NEGATIVE_INFINITY, timer: null }
      queues.set(host, queue)
    }
    return queue
  }

  const pump = (host: string): void => {
    const queue = queues.get(host)
    if (!queue) return

    if (queue.timer !== null) {
      clearTimer(queue.timer)
      queue.timer = null
    }

    if (queue.waiters.length === 0) {
      // Nothing waiting and no timer pending: the host has no state left worth
      // holding. `lastReleasedAt` goes with it, which is correct — an idle host
      // owes nothing, and re-arriving after the interval has already elapsed is
      // indistinguishable from arriving first.
      if (now() - queue.lastReleasedAt >= minIntervalMs) queues.delete(host)
      return
    }

    const readyAt = queue.lastReleasedAt + minIntervalMs
    const wait = readyAt - now()
    if (wait > 0) {
      queue.timer = setTimer(() => {
        queue.timer = null
        pump(host)
      }, wait)
      return
    }

    const waiter = queue.waiters.shift()
    if (!waiter) return
    queue.lastReleasedAt = now()
    waiter.detach()
    waiter.resolve()

    if (queue.waiters.length > 0) {
      queue.timer = setTimer(() => {
        queue.timer = null
        pump(host)
      }, minIntervalMs)
    }
  }

  return {
    acquire(host, signal): Promise<void> {
      if (signal?.aborted) {
        return Promise.reject(new RateLimitAbortedError(signal.reason))
      }

      return new Promise<void>((resolve, reject) => {
        const queue = queueFor(host)

        const onAbort = (): void => {
          const index = queue.waiters.indexOf(waiter)
          if (index >= 0) queue.waiters.splice(index, 1)
          waiter.detach()
          reject(new RateLimitAbortedError(signal?.reason))
          // The departure may have emptied the queue, in which case there is a
          // timer to cancel.
          pump(host)
        }

        const waiter: Waiter = {
          resolve,
          detach: () => signal?.removeEventListener('abort', onAbort)
        }

        queue.waiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
        pump(host)
      })
    },

    waiting(host): number {
      return queues.get(host)?.waiters.length ?? 0
    }
  }
}
