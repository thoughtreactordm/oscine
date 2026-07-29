export interface ClosableAudioContext {
  close(): Promise<void>
}

export interface DecodedAudioContextLease<T extends ClosableAudioContext> {
  context: T
  /** Opaque identity for numeric points on this context's clock. */
  timeline: symbol
  release(): void
}

/**
 * One AudioContext clock shared by the scheduler's decoded current/next slots.
 *
 * Gapless and crossfade scheduling can only be sample-accurate when both
 * sources use the same clock. Leases keep that shared device alive until both
 * slot engines are disposed, then close it exactly once.
 */
export class DecodedAudioContextPool<T extends ClosableAudioContext> {
  readonly #createContext: () => T
  #context: T | null = null
  #timeline: symbol | null = null
  #leases = 0

  constructor(createContext: () => T) {
    this.#createContext = createContext
  }

  acquire(): DecodedAudioContextLease<T> {
    const context = this.#context ?? this.#createContext()
    const timeline = this.#timeline ?? Symbol('decoded-audio-context')
    this.#context = context
    this.#timeline = timeline
    this.#leases += 1
    let released = false

    return {
      context,
      timeline,
      release: () => {
        if (released) return
        released = true
        this.#release(context)
      }
    }
  }

  #release(context: T): void {
    if (context !== this.#context) return
    this.#leases = Math.max(0, this.#leases - 1)
    if (this.#leases !== 0) return
    this.#context = null
    this.#timeline = null
    void context.close()
  }
}
