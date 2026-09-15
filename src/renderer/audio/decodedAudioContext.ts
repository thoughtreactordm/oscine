export interface ClosableAudioContext {
  close(): Promise<void>
}

export interface DecodedAudioContextLease<T extends ClosableAudioContext> {
  context: T
  /**
   * Where this context's engine connects its master gain. `context.destination`
   * by default; the EQ router populates it with its chain input at creation, so
   * the engine connects through the equalizer without ever learning it exists.
   */
  destination: AudioNode
  /** Opaque identity for numeric points on this context's clock. */
  timeline: symbol
  release(): void
}

/** Default terminal for a context with no EQ chain: the device destination itself. */
function contextDestination<T extends ClosableAudioContext>(context: T): AudioNode {
  return (context as unknown as { destination: AudioNode }).destination
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
  readonly #resolveDestination: (context: T) => AudioNode
  #context: T | null = null
  #destination: AudioNode | null = null
  #timeline: symbol | null = null
  #leases = 0

  /**
   * `resolveDestination` is computed once per context, the moment it is built,
   * and cached alongside it — every slot leasing that shared context connects to
   * the same terminal. Defaults to the context's own destination so a pool built
   * without an EQ still plays.
   */
  constructor(
    createContext: () => T,
    resolveDestination: (context: T) => AudioNode = contextDestination
  ) {
    this.#createContext = createContext
    this.#resolveDestination = resolveDestination
  }

  acquire(): DecodedAudioContextLease<T> {
    const context = this.#context ?? this.#createContext()
    const destination = this.#destination ?? this.#resolveDestination(context)
    const timeline = this.#timeline ?? Symbol('decoded-audio-context')
    this.#context = context
    this.#destination = destination
    this.#timeline = timeline
    this.#leases += 1
    let released = false

    return {
      context,
      destination,
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
    this.#destination = null
    this.#timeline = null
    void context.close()
  }
}
