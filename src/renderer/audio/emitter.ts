/**
 * A minimal typed event emitter.
 *
 * `on` returns an unsubscribe function rather than pairing with an `off` that
 * takes the same reference — the same shape `library.onScanProgress` already
 * uses, and the one that survives arrow-function listeners, which cannot be
 * passed to `off` at all.
 *
 * Not `EventTarget`: that would force every payload through `CustomEvent.detail`
 * and lose the per-event typing this exists to provide. Not a dependency
 * either — this is thirty lines, and a package would be a supply-chain surface
 * for no gain.
 */

export type Listener<T> = (payload: T) => void

// The constraint is self-referential rather than `Record<string, unknown>`
// because an `interface` gets no implicit index signature and so fails that
// simpler bound. Event maps read better as interfaces, and the shape of this
// constraint should not dictate how callers declare theirs.
export class Emitter<EventMap extends Record<keyof EventMap, unknown>> {
  // The internal map cannot stay precise across all keys at once, so it is
  // typed loosely here and narrowed at the public boundary. `on` and `emit`
  // are exact, and they are all callers ever touch.
  readonly #listeners = new Map<keyof EventMap, Set<Listener<never>>>()

  /** Subscribe. Returns the unsubscribe function; calling it twice is safe. */
  on<K extends keyof EventMap>(type: K, listener: Listener<EventMap[K]>): () => void {
    let set = this.#listeners.get(type)
    if (!set) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    const listeners = set
    listeners.add(listener as Listener<never>)

    return () => {
      listeners.delete(listener as Listener<never>)
    }
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const listeners = this.#listeners.get(type)
    if (!listeners) return
    // Iterate a copy: a listener that unsubscribes itself — or subscribes
    // another — must not mutate the set being walked.
    for (const listener of [...listeners]) {
      ;(listener as Listener<EventMap[K]>)(payload)
    }
  }

  /** Drop every listener. Used by `dispose`, so a discarded engine leaks none. */
  clear(): void {
    this.#listeners.clear()
  }

  /** Live listener count for a type. Exists for tests to assert cleanup. */
  count<K extends keyof EventMap>(type: K): number {
    return this.#listeners.get(type)?.size ?? 0
  }
}
