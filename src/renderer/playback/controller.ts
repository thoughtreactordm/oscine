import { computed, ref } from 'vue'
// The contract module, not the `audio/` barrel. The barrel is the runtime door
// — it hands out `createAudioEngine` and so pulls in the Web Audio
// implementation with it — whereas this file only ever needs the contract.
// Reaching for the barrel here would drag `AudioContext` and `window` into
// every project that compiles this module, and `tests/` compiles under the node
// config, which has no DOM. Same reason `trackWindow.ts` names no alias.
import {
  AudioEngineError,
  type AudioEngine,
  type NormalizationMode,
  type PlaybackStatus
} from '../audio/AudioEngine'
import type {
  ListTracksQuery,
  ListTracksResult,
  SortDirection,
  Track,
  TrackSortColumn
} from '@shared/library'
import { createListPlayOrder, type PlayOrder } from './playOrder'
import { PlaybackScheduler, type PrefetchState, type PrefetchStatus } from './scheduler'

/**
 * The bridge between the `AudioEngine` and the UI.
 *
 * The engine remains the single source of truth for time, duration and status;
 * everything here is a mirror of its events, kept because a Vue template cannot
 * subscribe to one. Nothing in this file reads the engine's getters on a timer —
 * a counter maintained alongside the audio clock is a counter that drifts.
 *
 * Built as a factory rather than written straight into `defineStore` for the
 * same reason `createTrackWindow` was: with the engine and the page fetch
 * injected, the whole of playback's control flow — supersession, end-of-order,
 * scrub arbitration — is testable under plain Node with no `AudioContext` and
 * no Electron. `stores/playback.ts` is the one place the real ones are bolted
 * on.
 */

export interface PlaybackControllerDeps {
  /**
   * Called at most once, lazily, on the first attempt to play. Constructing an
   * engine grabs an audio device, and browser autoplay policy only reliably
   * resumes one during a user gesture — so creation waits for a real click
   * rather than happening at mount.
   */
  createEngine: () => AudioEngine
  fetchPage: (query: ListTracksQuery) => Promise<ListTracksResult>
  /** R2 input until M4 supplies the value captured with a playlist traversal. */
  crossfadeMs?: number
  /** ReplayGain policy; track normalization is the M2 default. */
  normalizationMode?: NormalizationMode
}

export interface PlayFromListParams {
  sort: TrackSortColumn
  direction: SortDirection
  index: number
  /**
   * The row the user clicked. Supplied so the panel can show a title
   * immediately instead of waiting on a round trip for a row the list already
   * had.
   */
  track?: Track
}

export function createPlaybackController(deps: PlaybackControllerDeps) {
  const status = ref<PlaybackStatus>('idle')
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(1)
  const crossfadeMs = ref(
    Number.isFinite(deps.crossfadeMs) && (deps.crossfadeMs ?? 0) > 0 ? (deps.crossfadeMs ?? 0) : 0
  )
  const normalizationMode = ref<NormalizationMode>(deps.normalizationMode ?? 'track')
  const nowPlaying = ref<Track | null>(null)
  const error = ref<string | null>(null)
  const prefetchStatus = ref<PrefetchStatus>('idle')
  const prefetchedTrackId = ref<number | null>(null)
  const prefetchError = ref<string | null>(null)

  /** Position of the playing track within `order`, or `null` when idle. */
  const orderIndex = ref<number | null>(null)

  /**
   * True while the user holds the seek handle.
   *
   * The engine keeps emitting `timeupdate` throughout a drag, and letting those
   * events write `currentTime` would yank the handle back under the pointer
   * several times a second.
   */
  const scrubbing = ref(false)

  /**
   * Deliberately NOT a `ref`. Vue deep-proxies whatever it wraps, and reading a
   * `#private` field through a Proxy throws — the engine would fail on its
   * first getter. It is not reactive data anyway; the refs above mirror it.
   */
  let scheduler: PlaybackScheduler | null = null
  let unsubscribes: Array<() => void> = []
  let order: PlayOrder | null = null

  /**
   * Bumped by every play request. A request that finds the token changed while
   * it was awaiting has been superseded and must touch nothing — this is what
   * keeps rapid skipping from leaving a previous track's audio running
   * underneath the current one.
   *
   * The engine has its own generation guard, so this is belt and braces. It
   * covers the window the engine cannot see: between `load` resolving and
   * `play` being called, and across the `PlayOrder` lookup that precedes both.
   */
  let requestToken = 0

  const isPlaying = computed(() => status.value === 'playing')
  const isLoading = computed(() => status.value === 'loading')
  const hasTrack = computed(() => nowPlaying.value !== null)
  const canSeek = computed(() => duration.value > 0)

  function clampTime(seconds: number): number {
    if (!Number.isFinite(seconds)) return 0
    return Math.min(Math.max(seconds, 0), Math.max(0, duration.value))
  }

  function applyPrefetch(state: PrefetchState): void {
    prefetchStatus.value = state.status
    prefetchedTrackId.value = state.trackId
    prefetchError.value = state.error?.message ?? null
  }

  function ensureScheduler(): PlaybackScheduler {
    if (scheduler) return scheduler

    const created = new PlaybackScheduler({
      createEngine: deps.createEngine,
      crossfadeMs: crossfadeMs.value,
      normalizationMode: normalizationMode.value
    })
    unsubscribes = [
      created.on('statuschange', (next) => {
        status.value = next
      }),
      created.on('timeupdate', (position) => {
        duration.value = position.duration
        if (!scrubbing.value) currentTime.value = position.currentTime
      }),
      created.on('error', (err) => {
        error.value = err.message
      }),
      created.on('trackchange', ({ track, index }) => {
        nowPlaying.value = track
        orderIndex.value = index
      }),
      created.on('prefetchchange', applyPrefetch)
    ]

    // A volume set before the first play still has to reach the device.
    created.setVolume(volume.value)
    scheduler = created
    return created
  }

  /**
   * Loads and starts a track, unless a newer request has taken over.
   *
   * Both awaits are followed by a token check because either can lose the race:
   * a slow decode can outlive two more clicks.
   */
  async function startAt(index: number, track?: Track): Promise<void> {
    const active = ensureScheduler()
    if (!order) return

    try {
      await active.start(order, index, track)
    } catch (err) {
      // `load` rejects *and* emits `error`, and the subscription above already
      // turned that into a notice — handling both would double-report. The one
      // case worth swallowing outright is `aborted`, which is not a fault: it
      // means a newer track superseded this one mid-decode.
      if (err instanceof AudioEngineError && err.code === 'aborted') return
    }
  }

  /**
   * Moves to a position in the current order and plays what is there.
   *
   * `orderIndex` is written *before* the lookup is awaited so that two fast
   * presses of Next advance two rows. Reading it after the await would have
   * both presses compute the same target.
   */
  async function goTo(index: number): Promise<void> {
    if (!order || !scheduler) return

    const token = ++requestToken
    const previousIndex = orderIndex.value
    orderIndex.value = index

    try {
      const track = await scheduler.goTo(index)
      if (token !== requestToken || track === undefined) return
      if (!track) {
        // Off the end of the order. The scheduler has paused the current track.
        orderIndex.value = previousIndex
      }
    } catch {
      if (token === requestToken) {
        orderIndex.value = previousIndex
        if (!error.value) error.value = 'Could not read the next track.'
      }
    }
  }

  /**
   * Starts a track from the track list, capturing the list's ordering as the
   * play order. See the note in `playOrder.ts` on why it is a snapshot.
   */
  async function playFromList(params: PlayFromListParams): Promise<void> {
    order = createListPlayOrder({
      fetchPage: deps.fetchPage,
      sort: params.sort,
      direction: params.direction
    })

    // With the row already in hand there is nothing to look up, so skip `goTo`
    // and its round trip.
    if (params.track) {
      ++requestToken
      orderIndex.value = params.index
      nowPlaying.value = params.track
      error.value = null
      await startAt(params.index, params.track)
      return
    }

    ++requestToken
    error.value = null
    await startAt(params.index)
  }

  async function next(): Promise<void> {
    if (orderIndex.value === null) return
    await goTo(orderIndex.value + 1)
  }

  async function previous(): Promise<void> {
    // At the first row there is nowhere to go. Restarting the current track
    // instead is a convention worth having, but it belongs with the rest of the
    // transport polish rather than smuggled in here.
    if (orderIndex.value === null || orderIndex.value <= 0) return
    await goTo(orderIndex.value - 1)
  }

  async function toggle(): Promise<void> {
    if (!nowPlaying.value) return
    const active = ensureScheduler()
    if (status.value === 'playing') active.pause()
    else await active.play()
  }

  /** Called when the seek handle is grabbed; suspends follow until released. */
  function beginScrub(): void {
    scrubbing.value = true
  }

  /** Moves the handle without committing — the audio does not jump mid-drag. */
  function scrubTo(seconds: number): void {
    currentTime.value = clampTime(seconds)
  }

  /**
   * Commits the held position and resumes follow. Idempotent: a pointer release
   * and the input's `change` event both land, and keyboard seeking produces
   * neither a grab nor a release.
   */
  function endScrub(): void {
    if (!scrubbing.value) return
    scrubbing.value = false
    scheduler?.seek(currentTime.value)
  }

  /** A seek with no drag behind it — keyboard, or a click on the track. */
  function seek(seconds: number): void {
    currentTime.value = clampTime(seconds)
    scheduler?.seek(currentTime.value)
  }

  function setVolume(gain: number): void {
    const clamped = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 0
    volume.value = clamped
    // Before the first play there is no engine; `ensureEngine` replays it.
    scheduler?.setVolume(clamped)
  }

  function setCrossfadeMs(milliseconds: number): void {
    const normalized = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0
    crossfadeMs.value = normalized
    scheduler?.setCrossfadeMs(normalized)
  }

  function setNormalizationMode(mode: NormalizationMode): void {
    normalizationMode.value = mode
    scheduler?.setNormalizationMode(mode)
  }

  /** Stop playback and invalidate current and prefetched work. */
  function stop(): void {
    requestToken++
    scheduler?.stop()
    order = null
    orderIndex.value = null
    nowPlaying.value = null
    error.value = null
    currentTime.value = 0
    duration.value = 0
  }

  /** Releases the audio device and every subscription. Safe to call twice. */
  function dispose(): void {
    for (const off of unsubscribes) off()
    unsubscribes = []
    scheduler?.dispose()
    scheduler = null
    // Strands anything still in flight so it cannot resurrect a disposed engine.
    requestToken++
    order = null
    status.value = 'idle'
    applyPrefetch({
      status: 'idle',
      index: null,
      trackId: null,
      transitionPolicy: null,
      error: null
    })
  }

  return {
    status,
    currentTime,
    duration,
    volume,
    crossfadeMs,
    normalizationMode,
    nowPlaying,
    orderIndex,
    error,
    prefetchStatus,
    prefetchedTrackId,
    prefetchError,
    scrubbing,
    isPlaying,
    isLoading,
    hasTrack,
    canSeek,
    playFromList,
    next,
    previous,
    toggle,
    beginScrub,
    scrubTo,
    endScrub,
    seek,
    setVolume,
    setCrossfadeMs,
    setNormalizationMode,
    stop,
    dispose,
    /** Test seam: whether the audio device has actually been claimed yet. */
    hasEngine: (): boolean => scheduler !== null,
    /** Test seam: the ordering currently being played through. */
    orderId: (): string | null => order?.id ?? null
  }
}

export type PlaybackController = ReturnType<typeof createPlaybackController>
