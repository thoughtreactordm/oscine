/**
 * Where audio goes, for every context the audio module owns.
 *
 * `audio.outputDevice` is deliberately not part of `AudioEngine`. The sink is a
 * property of an `AudioContext`, and the two paths do not have one context each
 * — the decoded path shares a single pooled context between the playing and
 * prefetched slots so their clocks agree, and the streaming path builds one per
 * engine. An engine-level setter would therefore be a setter that four objects
 * could each apply to a device two of them share. The router below is the shape
 * that actually matches: one desired device, applied to every live context, and
 * applied again to each new one as it is created.
 *
 * `setSinkId` on `AudioContext` is Chromium-only and recent. It is feature-
 * detected rather than assumed, and `supported` is what the settings control
 * reads to decide whether to offer a picker at all — a control that silently did
 * nothing would be worse than one that says the runtime cannot do it.
 */

/** The slice of `AudioContext` this module needs. Keeps the tests free of Web Audio. */
export interface SinkCapableContext {
  readonly state: string
  setSinkId?: (sinkId: string) => Promise<void>
}

/**
 * The empty string is the system default, and is what `setSinkId` itself means
 * by it. Kept as a named value because "" reads as a missing argument.
 */
export const SYSTEM_DEFAULT_OUTPUT_DEVICE = ''

export class AudioOutputRouter {
  readonly #contexts = new Set<SinkCapableContext>()
  #deviceId = SYSTEM_DEFAULT_OUTPUT_DEVICE

  get deviceId(): string {
    return this.#deviceId
  }

  /** True when at least one live context can be re-pointed. */
  get supported(): boolean {
    this.#prune()
    for (const context of this.#contexts) {
      if (typeof context.setSinkId === 'function') return true
    }
    return false
  }

  /**
   * Take ownership of a freshly built context and point it at the current
   * device.
   *
   * Returns the context so a caller can wrap a constructor in one expression.
   * The promise from the initial `setSinkId` is deliberately not awaited: a
   * context is built on the path to playing something, and making that path wait
   * on a device switch would turn a settings preference into playback latency.
   * A failure is reported and the context keeps the default device, which is the
   * outcome an unplugged interface should have.
   */
  adopt<T extends SinkCapableContext>(context: T): T {
    this.#prune()
    this.#contexts.add(context)
    if (this.#deviceId !== SYSTEM_DEFAULT_OUTPUT_DEVICE) void this.#apply(context)
    return context
  }

  /**
   * Point every live context at a device. Resolves when they all have.
   *
   * Awaited here, unlike in `adopt`, because this one is a user action with a
   * control waiting on its result: an operator who picks a device that has since
   * been unplugged needs to be told, not left looking at a selected row that
   * nothing is coming out of.
   */
  async setDevice(deviceId: string): Promise<void> {
    this.#deviceId = deviceId
    this.#prune()
    await Promise.all([...this.#contexts].map((context) => this.#apply(context)))
  }

  async #apply(context: SinkCapableContext): Promise<void> {
    if (typeof context.setSinkId !== 'function') return
    try {
      await context.setSinkId(this.#deviceId)
    } catch (error) {
      // Not thrown on: one context failing must not leave the others pointed at
      // a device the operator has moved away from.
      console.warn('[audio] could not select the output device:', error)
    }
  }

  /**
   * Forget closed contexts.
   *
   * The pool closes its context when the last slot is disposed and a streaming
   * platform closes its own; neither tells this router, and neither should have
   * to. Holding a closed context would leak it and make every later `setDevice`
   * do work that can only reject.
   */
  #prune(): void {
    for (const context of this.#contexts) {
      if (context.state === 'closed') this.#contexts.delete(context)
    }
  }
}
