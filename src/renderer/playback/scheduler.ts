import type { Track } from '@shared/library'
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type AudioTransitionPolicy,
  type PlaybackPosition,
  type PlaybackStatus
} from '../audio/AudioEngine'
import { Emitter } from '../audio/emitter'
import type { PlayOrder } from './playOrder'

export type PrefetchStatus = 'idle' | 'resolving' | 'loading' | 'ready' | 'failed'

export interface PrefetchState {
  status: PrefetchStatus
  index: number | null
  trackId: number | null
  transitionPolicy: AudioTransitionPolicy | null
  error: AudioEngineError | null
}

export interface PlaybackSchedulerEventMap extends AudioEngineEventMap {
  trackchange: { track: Track; index: number }
  prefetchchange: PrefetchState
}

export interface PlaybackSchedulerDeps {
  createEngine: () => AudioEngine
}

interface Slot {
  engine: AudioEngine
  track: Track | null
  index: number | null
  load: Promise<void> | null
  unsubscribes: Array<() => void>
}

const idlePrefetch = (): PrefetchState => ({
  status: 'idle',
  index: null,
  trackId: null,
  transitionPolicy: null,
  error: null
})

/**
 * Owns audible playback and exactly one prepared successor.
 *
 * Play order enters here as an immutable traversal snapshot. The scheduler,
 * rather than a component or Pinia action, resolves the next row and prepares
 * its engine while the current source is audible. Natural transitions only
 * promote already-started work; they never perform a fresh lookup, fetch or
 * decode for the track whose boundary just arrived.
 */
export class PlaybackScheduler {
  readonly #events = new Emitter<PlaybackSchedulerEventMap>()
  readonly #createEngine: () => AudioEngine

  #slots: Slot[] = []
  #active: Slot | null = null
  #prefetched: Slot | null = null
  #order: PlayOrder | null = null
  #prefetchTask: Promise<void> | null = null
  #prefetchState: PrefetchState = idlePrefetch()
  #generation = 0
  #boundaryGeneration = 0
  #volume = 1
  #disposed = false

  constructor(deps: PlaybackSchedulerDeps) {
    this.#createEngine = deps.createEngine
  }

  get currentTime(): number {
    return this.#active?.engine.currentTime ?? 0
  }

  get duration(): number {
    return this.#active?.engine.duration ?? 0
  }

  get volume(): number {
    return this.#volume
  }

  get status(): PlaybackStatus {
    return this.#active?.engine.status ?? 'idle'
  }

  get trackId(): number | null {
    return this.#active?.track?.id ?? null
  }

  get transitionPolicy(): AudioTransitionPolicy {
    return this.#active?.engine.transitionPolicy ?? 'hard'
  }

  get prefetchState(): PrefetchState {
    return this.#prefetchState
  }

  on<K extends keyof PlaybackSchedulerEventMap>(
    type: K,
    listener: (payload: PlaybackSchedulerEventMap[K]) => void
  ): () => void {
    return this.#events.on(type, listener)
  }

  /**
   * Establish a new traversal and start its selected row.
   *
   * `knownTrack` is the list row the user activated. Supplying it avoids
   * querying for information already present in the UI without making the UI
   * responsible for any audio preparation.
   */
  async start(
    order: PlayOrder,
    index: number,
    knownTrack?: Track
  ): Promise<Track | null | undefined> {
    this.#assertUsable()
    this.#order = order
    return this.#goTo(index, knownTrack)
  }

  /** Move inside the captured order. `undefined` means a newer command won. */
  async goTo(index: number): Promise<Track | null | undefined> {
    this.#assertUsable()
    return this.#goTo(index)
  }

  async next(): Promise<Track | null | undefined> {
    const index = this.#active?.index
    if (index === null || index === undefined) return undefined
    return this.goTo(index + 1)
  }

  async previous(): Promise<Track | null | undefined> {
    const index = this.#active?.index
    if (index === null || index === undefined || index <= 0) return undefined
    return this.goTo(index - 1)
  }

  async play(): Promise<void> {
    this.#assertUsable()
    if (!this.#active) {
      throw new AudioEngineError('internal', 'Nothing is loaded.')
    }
    await this.#active.engine.play()
  }

  pause(): void {
    this.#active?.engine.pause()
  }

  seek(seconds: number): void {
    this.#assertUsable()
    // If natural-end handling is waiting for maintenance work, a seek is a
    // newer transport intent and must prevent that old boundary from promoting.
    this.#boundaryGeneration += 1
    this.#active?.engine.seek(seconds)
  }

  setVolume(gain: number): void {
    const target = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 0
    this.#volume = target
    for (const slot of this.#slots) slot.engine.setVolume(target)
  }

  /**
   * Invalidate every lookup and decode and release both engine slots.
   *
   * AudioEngine intentionally has no public unload operation. Disposal is the
   * only operation that can guarantee a stopped slot cannot later publish a
   * result, so a later start lazily creates a fresh pair.
   */
  stop(): void {
    if (this.#disposed) return
    this.#generation += 1
    this.#boundaryGeneration += 1
    this.#order = null
    this.#active = null
    this.#prefetched = null
    this.#prefetchTask = null
    this.#destroySlots()
    this.#setPrefetch(idlePrefetch())
    this.#events.emit('statuschange', 'idle')
    this.#events.emit('timeupdate', { currentTime: 0, duration: 0 })
  }

  dispose(): void {
    if (this.#disposed) return
    this.stop()
    this.#disposed = true
    this.#events.clear()
  }

  async #goTo(index: number, knownTrack?: Track): Promise<Track | null | undefined> {
    const order = this.#order
    if (!order) return undefined

    const generation = ++this.#generation
    this.#boundaryGeneration += 1
    this.#setPrefetch(idlePrefetch())
    let track = knownTrack
    if (!track) {
      try {
        track = (await order.at(index)) ?? undefined
      } catch {
        if (generation !== this.#generation) return undefined
        const failure = new AudioEngineError('io-error', 'Could not read the next track.')
        this.#events.emit('error', failure)
        throw failure
      }
    }
    if (generation !== this.#generation) return undefined

    if (!track) {
      this.#active?.engine.pause()
      return null
    }

    const prepared =
      this.#prefetched?.index === index && this.#prefetched.track?.id === track.id
        ? this.#prefetched
        : null
    const previous = this.#active
    const target = prepared ?? this.#spareSlot()

    previous?.engine.pause()
    this.#active = target
    this.#prefetched = null
    target.track = track
    target.index = index
    this.#events.emit('trackchange', { track, index })

    try {
      if (prepared?.load) await prepared.load
      else {
        target.load = target.engine.load(track.id)
        await target.load
      }
      if (generation !== this.#generation) return undefined

      // A prepared engine reached `ready` while it was inaudible, so its state
      // events were deliberately suppressed. Publish the adopted state before
      // play changes it again.
      this.#events.emit('statuschange', target.engine.status)
      this.#emitPosition(target)
      await target.engine.play()
      if (generation !== this.#generation) return undefined
      void this.#beginPrefetch(generation)
      return track
    } catch (error) {
      if (generation !== this.#generation) return undefined
      if (error instanceof AudioEngineError && error.code === 'aborted') return undefined
      throw error
    }
  }

  async #beginPrefetch(generation: number): Promise<void> {
    const active = this.#active
    const order = this.#order
    if (!active || !order || active.index === null) return

    const index = active.index + 1
    this.#setPrefetch({
      status: 'resolving',
      index,
      trackId: null,
      transitionPolicy: null,
      error: null
    })

    const task = (async () => {
      let track: Track | null
      try {
        track = await order.at(index)
      } catch {
        if (!this.#isCurrent(generation, active)) return
        const failure = new AudioEngineError('io-error', 'Could not resolve the prefetched track.')
        this.#setPrefetch({
          status: 'failed',
          index,
          trackId: null,
          transitionPolicy: null,
          error: failure
        })
        return
      }
      if (!this.#isCurrent(generation, active)) return
      if (!track) {
        this.#prefetched = null
        this.#setPrefetch(idlePrefetch())
        return
      }

      const slot = this.#spareSlot()
      slot.track = track
      slot.index = index
      this.#prefetched = slot

      // Navigating backwards commonly makes the just-paused former current
      // track the next track again. Its source is already prepared; retain it
      // instead of paying for a duplicate decode.
      if (
        slot.engine.trackId === track.id &&
        ['ready', 'paused', 'ended'].includes(slot.engine.status)
      ) {
        this.#setPrefetch({
          status: 'ready',
          index,
          trackId: track.id,
          transitionPolicy: slot.engine.transitionPolicy,
          error: null
        })
        return
      }

      this.#setPrefetch({
        status: 'loading',
        index,
        trackId: track.id,
        transitionPolicy: null,
        error: null
      })

      try {
        slot.load = slot.engine.load(track.id)
        await slot.load
        if (!this.#isCurrent(generation, active) || this.#prefetched !== slot) return
        this.#setPrefetch({
          status: 'ready',
          index,
          trackId: track.id,
          transitionPolicy: slot.engine.transitionPolicy,
          error: null
        })
      } catch (error) {
        if (!this.#isCurrent(generation, active) || this.#prefetched !== slot) return
        if (error instanceof AudioEngineError && error.code === 'aborted') return
        const failure =
          error instanceof AudioEngineError
            ? error
            : new AudioEngineError('internal', 'The next track could not be prepared.', track.id)
        this.#setPrefetch({
          status: 'failed',
          index,
          trackId: track.id,
          transitionPolicy: null,
          error: failure
        })
      }
    })()

    this.#prefetchTask = task
    await task
    if (this.#prefetchTask === task) this.#prefetchTask = null
  }

  async #onNaturalEnd(slot: Slot, event: { trackId: number }): Promise<void> {
    if (this.#active !== slot || slot.track?.id !== event.trackId) return
    const boundaryGeneration = this.#boundaryGeneration
    this.#events.emit('ended', event)

    // A row lookup which has not resolved cannot be allowed to unlock a fresh
    // fetch/decode after the audible boundary. Fail closed; its late result is
    // invalidated and therefore cannot touch an engine slot.
    if (this.#prefetchState.status === 'resolving') {
      this.#generation += 1
      const failure = new AudioEngineError(
        'io-error',
        'The next track was not prepared before the boundary.'
      )
      this.#setPrefetch({
        status: 'failed',
        index: this.#prefetchState.index,
        trackId: null,
        transitionPolicy: null,
        error: failure
      })
      this.#events.emit('error', failure)
      return
    }

    // Only await work that began while the old track was playing. No resolver,
    // fetch or decode is initiated for this boundary.
    const pending = this.#prefetchTask
    if (pending) await pending
    if (this.#active !== slot || boundaryGeneration !== this.#boundaryGeneration) return

    if (this.#prefetchState.status === 'failed') {
      const failure =
        this.#prefetchState.error ??
        new AudioEngineError('internal', 'The next track could not be prepared.')
      this.#events.emit('error', failure)
      return
    }
    const next = this.#prefetched
    if (!next || this.#prefetchState.status === 'idle') return
    if (this.#prefetchState.status !== 'ready' || !next.track || next.index === null) return

    const generation = ++this.#generation
    this.#boundaryGeneration += 1
    this.#active = next
    this.#prefetched = null
    this.#events.emit('trackchange', { track: next.track, index: next.index })
    this.#events.emit('statuschange', next.engine.status)
    this.#emitPosition(next)

    try {
      await next.engine.play()
      if (generation === this.#generation) void this.#beginPrefetch(generation)
    } catch {
      // The adopted engine emits its own actionable playback error.
    }
  }

  #ensureSlots(): void {
    while (this.#slots.length < 2) {
      const slot: Slot = {
        engine: this.#createEngine(),
        track: null,
        index: null,
        load: null,
        unsubscribes: []
      }
      slot.engine.setVolume(this.#volume)
      slot.unsubscribes = [
        slot.engine.on('statuschange', (status) => {
          if (this.#active === slot) this.#events.emit('statuschange', status)
        }),
        slot.engine.on('timeupdate', (position) => {
          if (this.#active === slot) this.#events.emit('timeupdate', position)
        }),
        slot.engine.on('ended', (event) => {
          void this.#onNaturalEnd(slot, event)
        }),
        slot.engine.on('error', (error) => {
          if (this.#active === slot) this.#events.emit('error', error)
        })
      ]
      this.#slots.push(slot)
    }
  }

  #spareSlot(): Slot {
    this.#ensureSlots()
    const slot = this.#slots.find((candidate) => candidate !== this.#active)
    if (!slot) throw new AudioEngineError('internal', 'No playback slot is available.')
    return slot
  }

  #destroySlots(): void {
    for (const slot of this.#slots) {
      for (const unsubscribe of slot.unsubscribes) unsubscribe()
      slot.engine.dispose()
    }
    this.#slots = []
  }

  #isCurrent(generation: number, active: Slot): boolean {
    return generation === this.#generation && active === this.#active
  }

  #emitPosition(slot: Slot): void {
    const position: PlaybackPosition = {
      currentTime: slot.engine.currentTime,
      duration: slot.engine.duration
    }
    this.#events.emit('timeupdate', position)
  }

  #setPrefetch(state: PrefetchState): void {
    this.#prefetchState = state
    this.#events.emit('prefetchchange', state)
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AudioEngineError('internal', 'This playback scheduler has been disposed.')
    }
  }
}
