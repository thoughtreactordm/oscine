export interface ClosableAudioContext {
  close(): Promise<void>
}

export interface DecodedAudioContextLease<T extends ClosableAudioContext> {
  context: T
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
  #leases = 0

  constructor(createContext: () => T) {
    this.#createContext = createContext
  }

  acquire(): DecodedAudioContextLease<T> {
    const context = this.#context ?? this.#createContext()
    this.#context = context
    this.#leases += 1
    let released = false

    return {
      context,
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
    void context.close()
  }
}
