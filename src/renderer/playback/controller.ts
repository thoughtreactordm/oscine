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
  LibraryBrowseFilters,
  ListTracksQuery,
  ListTracksResult,
  SortDirection,
  Track,
  TrackSortColumn
} from '@shared/library'
import type { MediaSessionBinding, MediaSessionState, MediaSessionTransport } from './mediaSession'
import { createListPlayOrder, type PlayOrder } from './playOrder'
import { PlaybackScheduler, type PrefetchState, type PrefetchStatus } from './scheduler'
import { createShuffledPlayOrder, type ShuffledPlayOrder } from './shufflePlayOrder'
import { cycleRepeatMode, nextIndex, previousIndex, type RepeatMode } from './traversal'
import {
  readTransportPreferences,
  writeTransportPreferences,
  type TransportStorage
} from './transportPreferences'

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
  /**
   * Binds the OS now-playing surface — SMTC on Windows, MPRIS on Linux.
   *
   * Injected rather than constructed here for the same reason the engine is:
   * it needs `navigator.mediaSession` and an `<audio>` element, neither of
   * which exists under the node test config. Omitting it is a supported
   * configuration, not a degraded one — the transport is unaffected.
   *
   * It hangs off the controller rather than off a panel because the OS card is
   * a second view onto exactly the state the transport reads, and panels are
   * islands. Living here also means `dispose()` already covers it.
   */
  createMediaSession?: (deps: {
    state: MediaSessionState
    transport: MediaSessionTransport
  }) => MediaSessionBinding
  /**
   * Where shuffle and repeat are remembered. Omitting it is supported and
   * means the modes last for the session, which is what the tests want.
   */
  storage?: TransportStorage
  /**
   * The seed for a shuffle, drawn each time shuffle is switched on so that off
   * and on again reshuffles. Injected only so a test can assert a sequence.
   */
  createShuffleSeed?: () => number
}

export interface PlayFromListParams {
  sort: TrackSortColumn
  direction: SortDirection
  filters?: LibraryBrowseFilters
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

  const preferences = readTransportPreferences(deps.storage)
  const repeatMode = ref<RepeatMode>(preferences.repeat)
  const shuffleEnabled = ref(preferences.shuffle)

  /**
   * How many positions the playing order has, or `null` when unknown — which
   * includes the common case of repeat being off, where nothing needs it.
   *
   * Resolved eagerly when repeat makes it reachable, rather than at the moment
   * it is needed, because the moment it is needed is a Next press: the
   * transport writes `orderIndex` *before* awaiting anything so that two fast
   * presses advance two rows, and an await here would have both presses
   * compute the same target. Unknown degrades to not wrapping — one press in
   * the first instants of playback, at the very end of the order, which is the
   * cheapest possible thing to get wrong.
   */
  const orderTotal = ref<number | null>(null)

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
   * The unshuffled ordering, kept alongside `order` for the whole time a
   * shuffled one is playing.
   *
   * Shuffle has to be reversible without re-deriving anything: turning it off
   * mid-album resumes the linear order the user started from, including its
   * sort and its filters, which is information a shuffled order permutes but
   * does not replace. `order` is `shuffled ?? base`, never something third.
   */
  let baseOrder: PlayOrder | null = null
  let shuffledOrder: ShuffledPlayOrder | null = null

  /** Guards the one place a shuffle toggle awaits before it mutates state. */
  let shuffleToken = 0

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
      normalizationMode: normalizationMode.value,
      repeatMode: repeatMode.value
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
    const base = createListPlayOrder({
      fetchPage: deps.fetchPage,
      sort: params.sort,
      direction: params.direction,
      filters: params.filters
    })
    baseOrder = base

    // The clicked row is pinned to the front of the shuffle, so "shuffle is on"
    // never means "the row I clicked is not what plays". The pin resolves
    // without the permutation, so this costs the click path nothing — the
    // length query and the shuffle itself happen while the track is decoding.
    shuffledOrder = shuffleEnabled.value
      ? createShuffledPlayOrder(base, { seed: shuffleSeed(), pinnedBaseIndex: params.index })
      : null
    order = shuffledOrder ?? base
    const index = shuffledOrder ? 0 : params.index
    captureTotal()

    // With the row already in hand there is nothing to look up, so skip `goTo`
    // and its round trip.
    if (params.track) {
      ++requestToken
      orderIndex.value = index
      nowPlaying.value = params.track
      error.value = null
      await startAt(index, params.track)
      return
    }

    ++requestToken
    error.value = null
    await startAt(index)
  }

  async function next(): Promise<void> {
    const from = orderIndex.value
    if (from === null) return
    // Repeat-one is deliberately not honoured here: pressing Next under it
    // moves on, as it does in every player anyone has used. See `traversal.ts`.
    const index = nextIndex(from, orderTotal.value, repeatMode.value, 'explicit')
    if (index === null) {
      // The end of the order with nothing to wrap to. Pausing is what `goTo`
      // does on finding no row there, and doing it here as well keeps the
      // clean stop from depending on whether the length happened to be known.
      pause()
      return
    }
    await goTo(index)
  }

  async function previous(): Promise<void> {
    // At the first row there is nowhere to go without repeat. Restarting the
    // current track instead is a convention worth having, but it belongs with
    // the rest of the transport polish rather than smuggled in here.
    const from = orderIndex.value
    if (from === null) return
    const index = previousIndex(from, orderTotal.value, repeatMode.value)
    if (index === null) return
    await goTo(index)
  }

  function shuffleSeed(): number {
    return deps.createShuffleSeed?.() ?? Math.floor(Math.random() * 0x1_0000_0000)
  }

  /** Resolves the playing order's length in the background. See `orderTotal`. */
  function captureTotal(): void {
    orderTotal.value = null
    const captured = order
    // Only wrapping needs a length. Asking unconditionally would put a round
    // trip on the play path that the default configuration has no use for —
    // and the play path is the one that deliberately avoids a lookup when the
    // clicked row is already in hand.
    if (!captured || repeatMode.value === 'off') return
    void captured.count().then((total) => {
      // A newer order may have been captured while this was in flight, and its
      // length is not this one's.
      if (order === captured) orderTotal.value = total
    })
  }

  function setRepeatMode(mode: RepeatMode): void {
    if (mode === repeatMode.value) return
    repeatMode.value = mode
    persistPreferences()
    // Wrapping has just become possible, or just stopped being possible.
    captureTotal()
    // The scheduler decided the successor minutes ago and may have it decoded
    // and scheduled already, so this is a re-decision rather than a setting.
    scheduler?.setRepeatMode(mode)
  }

  /** The single button's cycle: none, then the whole order, then this track. */
  function cycleRepeat(): void {
    setRepeatMode(cycleRepeatMode(repeatMode.value))
  }

  /**
   * Switch shuffle without interrupting what is playing.
   *
   * On, the playing row is pinned to the front of a fresh permutation and
   * keeps playing from its new position 0. Off, traversal resumes linearly
   * from where the user actually *is* rather than from where the shuffle
   * started — anything else would feel like the transport jumped.
   *
   * With nothing playing this only records the preference; it applies to the
   * next thing started from a list.
   */
  async function setShuffle(enabled: boolean): Promise<void> {
    if (enabled === shuffleEnabled.value) return
    shuffleEnabled.value = enabled
    persistPreferences()

    const base = baseOrder
    const current = orderIndex.value
    if (!base || !order || current === null || !scheduler) return
    const token = ++shuffleToken

    if (enabled) {
      const shuffled = createShuffledPlayOrder(base, {
        seed: shuffleSeed(),
        pinnedBaseIndex: current
      })
      shuffledOrder = shuffled
      order = shuffled
      orderIndex.value = 0
      scheduler.retarget(shuffled, 0)
    } else {
      const resumeAt = (await shuffledOrder?.baseIndexAt(current)) ?? current
      if (token !== shuffleToken) return
      shuffledOrder = null
      order = base
      orderIndex.value = resumeAt
      scheduler.retarget(base, resumeAt)
    }

    captureTotal()
  }

  async function toggleShuffle(): Promise<void> {
    await setShuffle(!shuffleEnabled.value)
  }

  function persistPreferences(): void {
    writeTransportPreferences(deps.storage, {
      repeat: repeatMode.value,
      shuffle: shuffleEnabled.value
    })
  }

  /**
   * Resume, and only resume.
   *
   * Separate from `toggle` because the OS media session needs an idempotent
   * intent rather than a flip: when a track is on the R1 streaming fallback its
   * real media element is a session participant alongside our silent anchor, so
   * a single OS play can reach playback twice. Two resumes settle on playing; a
   * second toggle would pause.
   */
  async function resume(): Promise<void> {
    if (!nowPlaying.value || status.value === 'playing') return
    await ensureScheduler().play()
  }

  /** Pause, and only pause. Idempotent for the same reason as `resume`. */
  function pause(): void {
    if (status.value !== 'playing') return
    scheduler?.pause()
  }

  async function toggle(): Promise<void> {
    if (!nowPlaying.value) return
    if (status.value === 'playing') pause()
    else await resume()
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
    shuffleToken++
    scheduler?.stop()
    order = null
    // The orders go; the modes stay. Shuffle and repeat are settings, and
    // stopping is not a request to change one.
    baseOrder = null
    shuffledOrder = null
    orderTotal.value = null
    orderIndex.value = null
    nowPlaying.value = null
    error.value = null
    currentTime.value = 0
    duration.value = 0
  }

  // Built now rather than on first play: it publishes nothing while `status` is
  // `idle`, and building it here means the OS card is already correct for a
  // track started from a media key rather than from the window.
  const mediaSession =
    deps.createMediaSession?.({
      state: { status, nowPlaying, currentTime, duration, scrubbing },
      transport: { resume, pause, stop, next, previous, seek }
    }) ?? null

  /** Releases the audio device and every subscription. Safe to call twice. */
  function dispose(): void {
    mediaSession?.dispose()
    for (const off of unsubscribes) off()
    unsubscribes = []
    scheduler?.dispose()
    scheduler = null
    // Strands anything still in flight so it cannot resurrect a disposed engine.
    requestToken++
    shuffleToken++
    order = null
    baseOrder = null
    shuffledOrder = null
    orderTotal.value = null
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
    orderTotal,
    repeatMode,
    shuffleEnabled,
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
    resume,
    pause,
    toggle,
    beginScrub,
    scrubTo,
    endScrub,
    seek,
    setVolume,
    setCrossfadeMs,
    setNormalizationMode,
    setRepeatMode,
    cycleRepeat,
    setShuffle,
    toggleShuffle,
    stop,
    dispose,
    /** Test seam: whether the audio device has actually been claimed yet. */
    hasEngine: (): boolean => scheduler !== null,
    /** Test seam: the OS media-session binding, or `null` when unbound. */
    mediaSession: (): MediaSessionBinding | null => mediaSession,
    /** Test seam: the ordering currently being played through. */
    orderId: (): string | null => order?.id ?? null
  }
}

export type PlaybackController = ReturnType<typeof createPlaybackController>
