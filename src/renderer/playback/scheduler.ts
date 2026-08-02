import type { Track } from '@shared/library'
import { AUDIO_PREFETCH_DEPTH } from '@shared/settings'
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type AudioTransitionPolicy,
  type NormalizationPolicy,
  type PlaybackPosition,
  type PlaybackStatus,
  type SampleAccurateTime,
  type WaveformBuffer
} from '../audio/AudioEngine'
import { Emitter } from '../audio/emitter'
import { DEFAULT_NORMALIZATION_POLICY, sameNormalizationPolicy } from '../audio/normalization'
import type { R1AdmissionDecision, R1Policy } from '../audio/r1Admission'
import type { PlayOrder } from './playOrder'
import { previousIndex, type AdvanceReason, type RepeatMode } from './traversal'
import {
  chooseSuccessor,
  orderPosition,
  samePosition,
  successorNeedsTotal,
  type QueueEntry,
  type SlotPosition,
  type Successor,
  type SuccessorQueue
} from './upNextQueue'

export type PrefetchStatus = 'idle' | 'resolving' | 'loading' | 'ready' | 'failed'

export interface PrefetchState {
  status: PrefetchStatus
  /** The successor's order position — its anchor when it came from the queue. */
  index: number | null
  /** The queue entry being warmed, or `null` when the successor is an order row. */
  queueEntryId: string | null
  trackId: number | null
  transitionPolicy: AudioTransitionPolicy | null
  error: AudioEngineError | null
}

export interface PlaybackSchedulerEventMap extends AudioEngineEventMap {
  trackchange: { track: Track; position: SlotPosition }
  /**
   * A track has begun playing. Emitted from the two — and only two — places a
   * play actually starts: a move inside `#goTo`, and the boundary in
   * `#onNaturalEnd`.
   *
   * Separate from `trackchange` because that event answers "what is the audible
   * track and where does it sit", and `retarget` restates it for a track that
   * is already playing when a shuffle toggle permutes the order underneath it.
   * A consumer counting plays off `trackchange` would count a shuffle as one.
   * Repeat-one, by contrast, comes back through the boundary and *is* a second
   * play, so it emits again — which is the behaviour the play-history trail
   * wants and the reason this is not simply deduplicated by track id.
   */
  playstart: { track: Track }
  prefetchchange: PrefetchState
}

export interface PlaybackSchedulerDeps {
  createEngine: () => AudioEngine
  /**
   * Stable R2 input. M4 will supply the playlist value; zero means gapless and
   * a positive value selects an equal-power crossfade.
   */
  crossfadeMs?: number
  normalizationPolicy?: NormalizationPolicy
  /** R1's budgets, forwarded to every slot this scheduler creates. */
  decodePolicy?: Partial<R1Policy>
  /**
   * `audio.prefetchDepth`: one prepared successor, or none.
   *
   * The scheduler has one prefetch slot, so this is 0 or 1 and the descriptor
   * clamps it there. Zero is not a smaller version of one — it removes the
   * prepared engine that a sample-accurate join needs, so a boundary falls back
   * to loading the successor when the current track ends.
   */
  prefetchDepth?: number
  /**
   * Traversal policy. It belongs here rather than in the transport because the
   * successor is decided while the current track is still audible — a repeat
   * mode consulted at the moment Next is pressed would be a repeat mode the
   * gapless boundary never saw.
   */
  repeatMode?: RepeatMode
  /**
   * The up-next queue, consulted before the order on every advance (§5 rule 1).
   *
   * Injected rather than owned because the queue is the renderer's — the UI
   * edits it, the controller holds it, and this only ever peeks at its head and
   * performs the shift when an advance commits. Omitting it is supported and
   * means traversal alone decides the successor, which is exactly M1 through M3.
   */
  queue?: SuccessorQueue
  onCrossfadeAdjusted?: (adjustment: CrossfadeAdjustment) => void
}

export interface CrossfadeAdjustment {
  requestedMs: number
  effectiveMs: number
  reasons: Array<'current-track' | 'next-track' | 'late-prefetch'>
}

interface Slot {
  engine: AudioEngine
  track: Track | null
  position: SlotPosition | null
  load: Promise<void> | null
  unsubscribes: Array<() => void>
}

/**
 * Normalized here as well as in the descriptor, for the reason the crossfade is:
 * the scheduler's behaviour must not depend on somebody else having validated
 * first. A non-integer or a negative reads as "no decode-ahead".
 */
function normalizePrefetchDepth(depth: number): number {
  return Number.isFinite(depth) && depth >= 1 ? 1 : 0
}

const idlePrefetch = (): PrefetchState => ({
  status: 'idle',
  index: null,
  queueEntryId: null,
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
  readonly #onCrossfadeAdjusted: (adjustment: CrossfadeAdjustment) => void
  readonly #queue: SuccessorQueue | null

  #crossfadeMs: number
  #normalizationPolicy: NormalizationPolicy
  /** `null` until somebody sets one: the engines then keep their own defaults. */
  #decodePolicy: Partial<R1Policy> | null
  #prefetchDepth: number
  #repeatMode: RepeatMode

  #slots: Slot[] = []
  #active: Slot | null = null
  #prefetched: Slot | null = null
  #order: PlayOrder | null = null
  #prefetchTask: Promise<void> | null = null
  #prefetchState: PrefetchState = idlePrefetch()
  #generation = 0
  #boundaryGeneration = 0
  /**
   * Invalidates prefetch alone.
   *
   * `#generation` cannot serve here. Changing the repeat mode or the play
   * order under a playing track has to strand the successor that is already
   * decoding, but bumping `#generation` would also strand an in-flight
   * `#goTo`, and that one has already emitted `trackchange` — the track would
   * be shown as playing and never start.
   */
  #prefetchToken = 0
  #volume = 1
  #disposed = false

  constructor(deps: PlaybackSchedulerDeps) {
    this.#createEngine = deps.createEngine
    this.#crossfadeMs = this.#normalizeCrossfadeMs(deps.crossfadeMs ?? 0)
    this.#normalizationPolicy = deps.normalizationPolicy ?? DEFAULT_NORMALIZATION_POLICY
    this.#decodePolicy = deps.decodePolicy ?? null
    this.#prefetchDepth = normalizePrefetchDepth(deps.prefetchDepth ?? AUDIO_PREFETCH_DEPTH.default)
    this.#repeatMode = deps.repeatMode ?? 'off'
    this.#queue = deps.queue ?? null
    this.#onCrossfadeAdjusted =
      deps.onCrossfadeAdjusted ??
      ((adjustment) => {
        console.info('[audio] R2 crossfade adjusted', JSON.stringify(adjustment))
      })
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

  get crossfadeMs(): number {
    return this.#crossfadeMs
  }

  get normalizationPolicy(): NormalizationPolicy {
    return this.#normalizationPolicy
  }

  get repeatMode(): RepeatMode {
    return this.#repeatMode
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

  /**
   * R1's verdict on the *audible* slot.
   *
   * The prefetched slot has one of its own and it is deliberately not reachable
   * here: the readout describes the track that is playing, and a decision about
   * the track after it would be the right shape and the wrong subject.
   */
  get admission(): R1AdmissionDecision | null {
    return this.#active?.engine.admission ?? null
  }

  get prefetchState(): PrefetchState {
    return this.#prefetchState
  }

  /**
   * The audible slot's waveform window.
   *
   * The active slot only, never a sum of both. During a crossfade the prefetched
   * slot is also sounding, but it is the outgoing track the transport is still
   * showing, and a picture that blended the two would disagree with every other
   * thing on screen at the one moment somebody is looking.
   */
  readWaveform(into: WaveformBuffer): boolean {
    return this.#active?.engine.readWaveform(into) ?? false
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
    return this.#goTo(orderPosition(index), knownTrack)
  }

  /** Move inside the captured order. `undefined` means a newer command won. */
  async goTo(index: number): Promise<Track | null | undefined> {
    this.#assertUsable()
    return this.#goTo(orderPosition(index))
  }

  /**
   * Start a queue entry at the position rule 1 named for it.
   *
   * `at` is taken as given rather than rebuilt from the current row, because
   * which position a queue entry carries is exactly what the two tiers disagree
   * about: a user entry inherits the *interrupted* row, since a detour does not
   * move the place it was taken from however many play in a row, while a
   * session entry carries its own order index because it *is* that row.
   * `chooseSuccessor` is the one place that fork lives; deriving it a second
   * time here is how the two would drift.
   */
  async goToQueued(entry: QueueEntry, at: SlotPosition): Promise<Track | null | undefined> {
    this.#assertUsable()
    return this.#goTo(at, entry.track)
  }

  async next(): Promise<Track | null | undefined> {
    const from = this.#active?.position
    if (!from) return undefined
    const successor = await this.#successor(from, 'explicit')
    if (successor === null) return null
    if (successor.kind === 'queue') return this.goToQueued(successor.entry, successor.position)
    return this.#goTo(successor.position)
  }

  async previous(): Promise<Track | null | undefined> {
    const from = this.#active?.position
    if (!from) return undefined
    // Backing out of a *user* detour returns to the row it was taken from, not
    // to the row before that: the interrupted row is what "previous" means to
    // anyone who just watched the queue cut in front of it. A session entry is
    // that row already, so it takes the ordinary step back instead.
    if (from.queueEntryId !== null && from.queueOrigin !== 'session') {
      return this.#goTo(orderPosition(from.index))
    }
    const total = this.#repeatMode === 'off' ? null : await this.#total()
    const index = previousIndex(from.index, total, this.#repeatMode)
    // `undefined` rather than `null`: nothing was attempted, so nothing was
    // superseded and nothing ran off the end either.
    if (index === null) return undefined
    return this.#goTo(orderPosition(index))
  }

  async play(): Promise<void> {
    this.#assertUsable()
    if (!this.#active) {
      throw new AudioEngineError('internal', 'Nothing is loaded.')
    }
    await this.#active.engine.play()
    this.#planBoundary()
  }

  pause(): void {
    this.#cancelPlannedBoundary()
    this.#active?.engine.pause()
  }

  seek(seconds: number): void {
    this.#assertUsable()
    // If natural-end handling is waiting for maintenance work, a seek is a
    // newer transport intent and must prevent that old boundary from promoting.
    this.#boundaryGeneration += 1
    this.#cancelPlannedBoundary()
    this.#active?.engine.seek(seconds)
    this.#planBoundary()
  }

  setVolume(gain: number): void {
    const target = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 0
    this.#volume = target
    for (const slot of this.#slots) slot.engine.setVolume(target)
  }

  setNormalizationPolicy(policy: NormalizationPolicy): void {
    this.#assertUsable()
    if (sameNormalizationPolicy(policy, this.#normalizationPolicy)) return
    this.#normalizationPolicy = policy
    for (const slot of this.#slots) slot.engine.setNormalizationPolicy(policy)
  }

  /**
   * Push R1's budgets to both slots.
   *
   * Held rather than only forwarded, because a slot created later — the prefetch
   * engine, or a fresh pair after `stop()` — has to start with the budget in
   * force rather than the registry default the constructor saw.
   */
  setDecodePolicy(policy: Partial<R1Policy>): void {
    this.#assertUsable()
    this.#decodePolicy = policy
    for (const slot of this.#slots) slot.engine.setDecodePolicy(policy)
  }

  get prefetchDepth(): number {
    return this.#prefetchDepth
  }

  /**
   * Take decode-ahead away, or give it back, without interrupting the track.
   *
   * Dropping to zero discards whatever is already prepared, through the same
   * path a reordered play order takes — the prefetch token bump is what makes an
   * in-flight load land on nothing. That is the point: the operator turned this
   * off because the decode-ahead itself was the problem, so leaving one last
   * prepared track resident would answer the wrong half of the request. Raising
   * it back to one prepares the successor at the next natural opportunity rather
   * than immediately, because
   * "immediately" would mean a decode starting under a track the user is in the
   * middle of listening to.
   */
  setPrefetchDepth(depth: number): void {
    this.#assertUsable()
    const next = normalizePrefetchDepth(depth)
    if (next === this.#prefetchDepth) return
    this.#prefetchDepth = next
    if (next === 0) this.#discardPrefetch()
  }

  /**
   * Replace R2's boundary policy without changing traversal or persistence.
   *
   * Any already-scheduled source and outgoing automation are cancelled first,
   * then rebuilt through the same boundary planner with the new value.
   */
  setCrossfadeMs(milliseconds: number): void {
    this.#assertUsable()
    const next = this.#normalizeCrossfadeMs(milliseconds)
    if (next === this.#crossfadeMs) return
    this.#crossfadeMs = next
    this.#cancelPlannedBoundary()
    this.#planBoundary()
  }

  /**
   * Change traversal under a playing track.
   *
   * The successor has usually already been decoded into the spare slot and
   * scheduled against the current source's exact end, so this is not a setter
   * — the decision it feeds has been made. Re-resolved rather than replanned,
   * because the new mode may name a different row.
   */
  setRepeatMode(mode: RepeatMode): void {
    this.#assertUsable()
    if (mode === this.#repeatMode) return
    this.#repeatMode = mode
    this.#resolveSuccessorAgain()
  }

  /**
   * Re-decide the successor after the queue was edited.
   *
   * An "add to queue" onto a non-empty queue changes nothing that is already
   * decoding, and `#resolveSuccessorAgain` keeps that decode rather than
   * discarding it. A "play next", or removing the head, does change it — and
   * has to reach the boundary that is already armed, or the queue would only
   * take effect from the track after the one the user was looking at.
   */
  queueChanged(): void {
    this.#assertUsable()
    this.#resolveSuccessorAgain()
  }

  /**
   * Swap the play order under the playing track without restarting it.
   *
   * Turning shuffle on mid-album must not interrupt anything: the row that is
   * audible stays audible and simply acquires a new position in a new order.
   * Only the successor changes, which is exactly what this invalidates.
   *
   * `index` is where the playing track now sits in `order`; the caller is the
   * one that built the order and so is the only thing that can know.
   */
  retarget(order: PlayOrder, index: number): void {
    this.#assertUsable()
    this.#order = order

    const active = this.#active
    if (!active || active.position === null) return
    // Only the order position moves. A queue detour is not a row of the order
    // and so is not permuted by one being swapped underneath it (§5 rule 6).
    // The tier travels with it: the playing entry is still whichever kind it
    // was, and Previous still has to be able to tell.
    const position: SlotPosition = {
      index,
      queueEntryId: active.position.queueEntryId,
      ...(active.position.queueOrigin ? { queueOrigin: active.position.queueOrigin } : {})
    }
    active.position = position
    if (active.track) this.#events.emit('trackchange', { track: active.track, position })
    this.#resolveSuccessorAgain({ force: true })
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
    this.#prefetchToken += 1
    this.#order = null
    this.#cancelPlannedBoundary()
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

  async #goTo(position: SlotPosition, knownTrack?: Track): Promise<Track | null | undefined> {
    const order = this.#order
    if (!order) return undefined

    const generation = ++this.#generation
    this.#boundaryGeneration += 1
    this.#cancelPlannedBoundary()
    this.#setPrefetch(idlePrefetch())
    let track = knownTrack
    // A queue entry carries its own row, so there is nothing to look up and no
    // failure to report. Only an order position needs asking about.
    if (!track && position.queueEntryId === null) {
      try {
        track = (await order.at(position.index)) ?? undefined
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
      this.#prefetched &&
      samePosition(this.#prefetched.position, position) &&
      this.#prefetched.track?.id === track.id
        ? this.#prefetched
        : null
    const previous = this.#active
    const target = prepared ?? this.#spareSlot()

    previous?.engine.pause()
    this.#active = target
    this.#prefetched = null
    target.track = track
    target.position = position
    // §5 rule 1's shift, at the moment this advance actually committed. An
    // explicit Next has usually consumed the row already — see `take`.
    if (position.queueEntryId !== null) this.#queue?.take(position.queueEntryId)
    this.#events.emit('trackchange', { track, position })
    this.#events.emit('playstart', { track })

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
    if (!active || !order || active.position === null) return
    // `audio.prefetchDepth` at zero. Left `idle` rather than announced as a
    // failure, because nothing failed: no successor was ever asked for, and the
    // natural-end handler reads `idle` as "there is nothing prepared" and loads
    // the successor the ordinary way. What is lost is the sample-accurate join,
    // which is what a depth of zero is trading away.
    if (this.#prefetchDepth < 1) {
      this.#setPrefetch(idlePrefetch())
      return
    }

    const from = active.position
    const token = ++this.#prefetchToken
    // Announced before the successor is even named, and that matters: the
    // natural-end handler reads `resolving` as "work is in flight, fail
    // closed", so a window of `idle` while the position is being decided would
    // let a boundary arriving in the first moments of a track read as a clean
    // end of the order.
    this.#setPrefetch({
      status: 'resolving',
      index: null,
      queueEntryId: null,
      trackId: null,
      transitionPolicy: null,
      error: null
    })

    const task = (async () => {
      const successor = await this.#successor(from, 'boundary')
      if (!this.#isPrefetchCurrent(generation, active, token)) return
      if (successor === null) {
        // Traversal stops here — the last row without repeat, and an empty
        // queue. Idle is what the boundary handler reads as "nothing follows",
        // which is the existing clean stop.
        this.#prefetched = null
        this.#setPrefetch(idlePrefetch())
        return
      }
      const { index, queueEntryId } = successor.position
      this.#setPrefetch({
        status: 'resolving',
        index,
        queueEntryId,
        trackId: null,
        transitionPolicy: null,
        error: null
      })

      // The card's "decode-ahead must prefetch the queue head": each arm of
      // rule 1 resolves its row from a different place, and only the order arm
      // is a round trip that can fail. A queue entry carries its own row and
      // `again` is already audible, so both are free and neither can warm the
      // wrong track by consulting the playing playlist's next entry.
      let track: Track | null
      if (successor.kind === 'queue') {
        track = successor.entry.track
      } else if (successor.kind === 'again') {
        track = active.track
      } else {
        try {
          track = await order.at(index)
        } catch {
          if (!this.#isPrefetchCurrent(generation, active, token)) return
          const failure = new AudioEngineError(
            'io-error',
            'Could not resolve the prefetched track.'
          )
          this.#setPrefetch({
            status: 'failed',
            index,
            queueEntryId,
            trackId: null,
            transitionPolicy: null,
            error: failure
          })
          return
        }
      }
      if (!this.#isPrefetchCurrent(generation, active, token)) return
      if (!track) {
        this.#prefetched = null
        this.#setPrefetch(idlePrefetch())
        return
      }

      const slot = this.#spareSlot()
      slot.track = track
      slot.position = successor.position
      this.#prefetched = slot

      // Navigating backwards commonly makes the just-paused former current
      // track the next track again. Its source is already prepared; retain it
      // instead of paying for a duplicate decode.
      //
      // Repeat-one lands here too, from the second lap onwards: promotion left
      // the outgoing slot holding this very track at `ended`, and an ended
      // decoded source can be scheduled again from zero. So a repeating track
      // ping-pongs between two slots and decodes exactly twice however long it
      // loops — which is also why R1 accounts two copies of it, not one.
      if (
        slot.engine.trackId === track.id &&
        ['ready', 'paused', 'ended'].includes(slot.engine.status)
      ) {
        this.#setPrefetch({
          status: 'ready',
          index,
          queueEntryId,
          trackId: track.id,
          transitionPolicy: slot.engine.transitionPolicy,
          error: null
        })
        this.#planBoundary(generation, active, slot)
        return
      }

      this.#setPrefetch({
        status: 'loading',
        index,
        queueEntryId,
        trackId: track.id,
        transitionPolicy: null,
        error: null
      })

      try {
        slot.load = slot.engine.load(track.id)
        await slot.load
        if (!this.#isPrefetchCurrent(generation, active, token) || this.#prefetched !== slot) return
        this.#setPrefetch({
          status: 'ready',
          index,
          queueEntryId,
          trackId: track.id,
          transitionPolicy: slot.engine.transitionPolicy,
          error: null
        })
        this.#planBoundary(generation, active, slot)
      } catch (error) {
        if (!this.#isPrefetchCurrent(generation, active, token) || this.#prefetched !== slot) return
        if (error instanceof AudioEngineError && error.code === 'aborted') return
        const failure =
          error instanceof AudioEngineError
            ? error
            : new AudioEngineError('internal', 'The next track could not be prepared.', track.id)
        this.#setPrefetch({
          status: 'failed',
          index,
          queueEntryId,
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
        queueEntryId: this.#prefetchState.queueEntryId,
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
    if (this.#prefetchState.status !== 'ready' || !next.track || next.position === null) return

    const generation = ++this.#generation
    this.#boundaryGeneration += 1
    this.#active = next
    this.#prefetched = null
    // §5 rule 1's shift. The boundary is the one moment the advance is certain,
    // and it is the only advance the controller is not party to.
    if (next.position.queueEntryId !== null) this.#queue?.take(next.position.queueEntryId)
    this.#events.emit('trackchange', { track: next.track, position: next.position })
    this.#events.emit('playstart', { track: next.track })
    const adoptedScheduled = next.engine.adoptScheduledStart()
    if (!adoptedScheduled) {
      this.#events.emit('statuschange', next.engine.status)
      this.#emitPosition(next)
    }

    try {
      if (!adoptedScheduled) await next.engine.play()
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
        position: null,
        load: null,
        unsubscribes: []
      }
      slot.engine.setVolume(this.#volume)
      slot.engine.setNormalizationPolicy(this.#normalizationPolicy)
      if (this.#decodePolicy) slot.engine.setDecodePolicy(this.#decodePolicy)
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

  #isPrefetchCurrent(generation: number, active: Slot, token: number): boolean {
    return token === this.#prefetchToken && this.#isCurrent(generation, active)
  }

  /**
   * §5 rule 1's seam, with the length query it may not need.
   *
   * The decision itself is `chooseSuccessor`; all this adds is the round trip,
   * which `successorNeedsTotal` skips whenever the queue or repeat-one has
   * already settled the answer.
   */
  async #successor(from: SlotPosition, reason: AdvanceReason): Promise<Successor | null> {
    const repeat = this.#repeatMode
    const head = this.#queue?.head() ?? null
    const total = successorNeedsTotal(head, repeat, reason) ? await this.#total() : null
    return chooseSuccessor({ from, head, total, repeat, reason })
  }

  /** The position being warmed, for comparison against a freshly decided one. */
  #prefetchPosition(): SlotPosition | null {
    const { index, queueEntryId } = this.#prefetchState
    return index === null ? null : { index, queueEntryId }
  }

  async #total(): Promise<number | null> {
    return (await this.#order?.count()) ?? null
  }

  /**
   * Re-decide the successor for a track that is already playing.
   *
   * By this point the old successor is usually decoded and scheduled against
   * the current source's sample-accurate end, so changing traversal means
   * unpicking a boundary rather than setting a flag.
   *
   * `force` is for a play order swap, where the position numbers may be
   * unchanged but no longer mean the same rows.
   */
  #resolveSuccessorAgain(options: { force?: boolean } = {}): void {
    const active = this.#active
    if (!active || active.position === null) return

    const generation = this.#generation
    const from = active.position

    void (async () => {
      const successor = await this.#successor(from, 'boundary')
      if (!this.#isCurrent(generation, active) || !samePosition(active.position, from)) return
      // A change that leaves the same row next keeps the decode that is already
      // prepared. Repeat-all differs from repeat-off only at the last row, and
      // an "add to queue" behind a queued row changes nothing at all;
      // discarding a ready boundary in either case would turn a button press
      // into an audible risk.
      if (!options.force && samePosition(successor?.position ?? null, this.#prefetchPosition())) {
        return
      }

      // The same row under a new *identity*, which is what a session fill does
      // to an armed boundary: the order row that was warmed becomes the queue
      // head holding that very track. Re-label the decode instead of throwing
      // it away — the session tier is installed on every play, so discarding
      // here would make a visible queue cost a re-decode every time.
      const prepared = this.#prefetched
      if (
        !options.force &&
        successor?.kind === 'queue' &&
        prepared !== null &&
        prepared.track !== null &&
        prepared.track.id === successor.entry.track.id
      ) {
        prepared.position = successor.position
        this.#setPrefetch({
          ...this.#prefetchState,
          index: successor.position.index,
          queueEntryId: successor.position.queueEntryId
        })
        return
      }

      this.#discardPrefetch()
      if (successor !== null) void this.#beginPrefetch(generation)
    })()
  }

  /**
   * Strand the prepared successor and everything scheduled against it.
   *
   * Deliberately not a `stop()`: the audible slot is untouched, so this is
   * inaudible unless it happens within the crossfade of a boundary — in which
   * case the boundary generation bump stops playback rather than promoting a
   * slot that no longer holds the right row.
   */
  #discardPrefetch(): void {
    this.#prefetchToken += 1
    this.#boundaryGeneration += 1
    this.#cancelPlannedBoundary()
    this.#prefetched = null
    this.#prefetchTask = null
    this.#setPrefetch(idlePrefetch())
  }

  /**
   * Put the decoded successor on the current source's exact end point.
   *
   * This runs only while both buffers are already prepared. The later natural
   * end callback changes public ownership; it does not fetch, decode, call
   * `play()`, or create another source node.
   */
  #planBoundary(
    generation = this.#generation,
    active = this.#active,
    next = this.#prefetched
  ): boolean {
    if (
      !active ||
      !next ||
      !this.#isCurrent(generation, active) ||
      this.#prefetched !== next ||
      this.#prefetchState.status !== 'ready' ||
      active.engine.transitionPolicy !== 'sample-accurate' ||
      next.engine.transitionPolicy !== 'sample-accurate'
    ) {
      return false
    }

    const boundary = active.engine.sampleAccurateEndTime
    if (!boundary) return false

    if (this.#crossfadeMs > 0) {
      return this.#planCrossfade(active, next, boundary)
    }

    next.engine.cancelScheduledStart()
    return next.engine.scheduleSampleAccurateStart(boundary)
  }

  #cancelPlannedBoundary(): void {
    this.#prefetched?.engine.cancelScheduledStart()
    this.#active?.engine.cancelScheduledFade()
  }

  #planCrossfade(active: Slot, next: Slot, boundary: SampleAccurateTime): boolean {
    const requestedSec = this.#crossfadeMs / 1000
    // Keep at least half of either very short track outside the overlap. Apart
    // from sounding less surprising, this guarantees the successor is still
    // running when public ownership moves at the outgoing source's end.
    const currentTrackLimit = active.engine.duration / 2
    const nextTrackLimit = next.engine.duration / 2
    // Planning exactly "now" races the audio render thread. A small lead makes
    // late-prefetch degradation deterministic and prevents a past-time start.
    const remainingSec = Math.max(0, active.engine.duration - active.engine.currentTime)
    const latePrefetchLimit = Math.max(0, remainingSec - 0.02)
    const effectiveSec = Math.min(
      requestedSec,
      currentTrackLimit,
      nextTrackLimit,
      latePrefetchLimit
    )

    if (effectiveSec < requestedSec) {
      const reasons: CrossfadeAdjustment['reasons'] = []
      if (currentTrackLimit < requestedSec) reasons.push('current-track')
      if (nextTrackLimit < requestedSec) reasons.push('next-track')
      if (latePrefetchLimit <= effectiveSec && latePrefetchLimit < requestedSec) {
        reasons.push('late-prefetch')
      }
      this.#onCrossfadeAdjusted({
        requestedMs: this.#crossfadeMs,
        effectiveMs: Math.round(effectiveSec * 1000),
        reasons
      })
    }
    if (effectiveSec <= 0) return false

    const start = {
      timeline: boundary.timeline,
      timeSec: boundary.timeSec - effectiveSec
    }
    next.engine.cancelScheduledStart()
    active.engine.cancelScheduledFade()
    if (!next.engine.scheduleSampleAccurateStart(start, effectiveSec)) return false
    if (active.engine.scheduleSampleAccurateFadeOut(start, effectiveSec)) return true

    next.engine.cancelScheduledStart()
    return false
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

  #normalizeCrossfadeMs(milliseconds: number): number {
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AudioEngineError('internal', 'This playback scheduler has been disposed.')
    }
  }
}
