import { AsyncLocalStorage } from 'node:async_hooks'
import {
  isEmptyLibraryChange,
  mergeLibraryChanges,
  type LibraryChanged,
  type LibraryChangeOrigin,
  type LibraryChangeSet
} from '@shared/libraryChanges'

/**
 * The main half of `library.changed` — **D36.9**.
 *
 * Write services hold one of these and call {@link LibraryChangeNotifier.notify}
 * once per committed call, after the transaction, with every id the call
 * touched. That is the coalescing rule: a 500-track override set is one event,
 * never 500. Emitting from the services rather than the IPC handlers is what
 * lets a write from any caller — IPC today, MCP tools later — announce itself.
 *
 * {@link LibraryChangeNotifier.batch} widens "one call" for an operation that
 * is a loop over service calls (the write-back apply retires overrides one file
 * at a time): everything notified inside the batch is merged and sent once
 * when it settles, whether it resolved or threw — a write that committed before
 * the failure still happened.
 */
export interface LibraryChangeNotifier {
  /** Announces a committed write. A change set naming nothing is dropped. */
  notify(changes: LibraryChangeSet): void
  /** Runs `fn`, holding every notification until it settles, then sends one. */
  batch<T>(fn: () => Promise<T>): Promise<T>
}

/** For services built without a notifier (most tests). */
export const NO_LIBRARY_CHANGES: LibraryChangeNotifier = {
  notify: () => {},
  batch: (fn) => fn()
}

/**
 * Who is writing, carried across awaits.
 *
 * Module-wide rather than per notifier because the caller is a property of the
 * call stack, not of the service: the IPC registry stamps every handler as
 * `renderer`, and the MCP server will stamp its tool calls as `agent`. Outside
 * either, the origin is `main`.
 */
const originStore = new AsyncLocalStorage<LibraryChangeOrigin>()

/** Runs `fn` with `origin` as the author of any library change it makes. */
export function withChangeOrigin<T>(origin: LibraryChangeOrigin, fn: () => T): T {
  return originStore.run(origin, fn)
}

/** The origin of the code currently running. */
export function currentChangeOrigin(): LibraryChangeOrigin {
  return originStore.getStore() ?? 'main'
}

interface PendingBatch {
  changes: LibraryChangeSet
}

export interface LibraryChangeNotifierDeps {
  /** Sends one payload at the renderer — `emit(…, 'library.changed', …)` in production. */
  emit: (event: LibraryChanged) => void
}

export function createLibraryChangeNotifier(
  deps: LibraryChangeNotifierDeps
): LibraryChangeNotifier {
  const batches = new AsyncLocalStorage<PendingBatch>()

  function send(changes: LibraryChangeSet, origin: LibraryChangeOrigin): void {
    if (isEmptyLibraryChange(changes)) return
    try {
      deps.emit({ origin, changes })
    } catch (error) {
      // An announcement must never fail the write it announces.
      console.error('[library] library.changed could not be sent:', error)
    }
  }

  return {
    notify(changes) {
      const pending = batches.getStore()
      if (pending) {
        pending.changes = mergeLibraryChanges(pending.changes, changes)
        return
      }
      send(mergeLibraryChanges({}, changes), currentChangeOrigin())
    },

    async batch(fn) {
      // A batch inside a batch joins the outer one: still one event.
      if (batches.getStore()) return fn()
      const pending: PendingBatch = { changes: {} }
      const origin = currentChangeOrigin()
      try {
        return await batches.run(pending, fn)
      } finally {
        send(pending.changes, origin)
      }
    }
  }
}
