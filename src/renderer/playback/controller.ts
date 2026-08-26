import { computed, ref, watch, type Ref } from 'vue'
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
  type NormalizationPolicy,
  type PlaybackStatus,
  type WaveformBuffer
} from '../audio/AudioEngine'
import type { R1AdmissionDecision } from '../audio/r1Admission'
import type {
  GetTracksByIdsQuery,
  LibraryBrowseFilters,
  ListTrackIdsQuery,
  ListTrackIdsResult,
  ListTracksQuery,
  ListTracksResult,
  SortDirection,
  Track,
  TrackSortColumn
} from '@shared/library'
import type { ListFavoritesQuery, ListFavoritesResult } from '@shared/favorites'
import type { RecordListenRequest } from '@shared/listens'
import type { ListPlaylistEntriesQuery, ListPlaylistEntriesResult } from '@shared/playlists'
import {
  AUDIO_CROSSFADE_MS,
  AUDIO_CROSSFADE_MS_KEY,
  EMPTY_QUEUE_SESSION,
  type QueueIntent,
  type QueueSession
} from '@shared/settings'
import { createListenRecorder } from './listenRecorder'
import type { MediaSessionBinding, MediaSessionState, MediaSessionTransport } from './mediaSession'
import {
  createFavoritesPlayOrder,
  createFixedPlayOrder,
  createListPlayOrder,
  createPlaylistPlayOrder,
  type PlayOrder
} from './playOrder'
import { PlaybackScheduler, type PrefetchState, type PrefetchStatus } from './scheduler'
import {
  favoritesScopeReader,
  libraryScopeReader,
  materializeSession,
  playlistScopeReader,
  type SessionRowReader
} from './sessionScope'
import { createShuffledPlayOrder, type ShuffledPlayOrder } from './shufflePlayOrder'
import { cycleRepeatMode, previousIndex, type RepeatMode } from './traversal'
import {
  chooseSuccessor,
  createUpNextQueue,
  orderPosition,
  type QueueEntry,
  type SlotPosition,
  type Successor
} from './upNextQueue'

/**
 * How many order rows a session fill materializes.
 *
 * Any realistic scope fits whole — a few artists, an album, a search all land
 * far under it — so the cap is only reached by "play the whole library", where
 * the truncation is invisible because nobody scrolls five thousand rows into a
 * queue. Broad scopes truncate and the play order carries on correctly behind
 * the truncation, because every session entry carries its own order position
 * and a drained tier resumes after the last one materialized rather than at the
 * anchor.
 *
 * Named rather than inlined because the number is a judgement about queue
 * *depth*, not about a page size: raising it costs memory in the renderer and
 * nothing at either end of the IPC.
 */
export const SESSION_QUEUE_CAP = 5000
import type { CascadingSettingsReader, SettingsReader } from '../settings/reader'
import { bindAudioPreferences } from './audioPreferences'
import { bindTransportPreferences } from './transportPreferences'

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
  /**
   * How a playlist traversal resolves a position. Required rather than
   * optional: a controller without it cannot honour `playFromPlaylist`, and an
   * absent dependency would turn that into a silent no-op at the one moment
   * the user is asking for audio.
   */
  fetchPlaylistEntries: (query: ListPlaylistEntriesQuery) => Promise<ListPlaylistEntriesResult>
  /**
   * How a favorites traversal resolves a position, and how its session tier is
   * filled — **D18**.
   *
   * One dependency where the library needs three, because `favorites.list`
   * already answers in the display projection and the collection has exactly one
   * order. Required for `fetchPlaylistEntries`' reason.
   */
  fetchFavorites: (query: ListFavoritesQuery) => Promise<ListFavoritesResult>
  /**
   * The two library verbs the session tier is materialized through.
   *
   * Required, and for the reason `fetchPlaylistEntries` gives: an optional
   * dependency here would turn "the up-next surface shows what is lined up"
   * into a silent no-op, which is the exact defect this tier exists to fix — a
   * scope that was genuinely queued and had nowhere to be seen. A playlist
   * session needs neither, because `fetchPlaylistEntries` already serves it.
   */
  fetchTrackIds: (query: ListTrackIdsQuery) => Promise<ListTrackIdsResult>
  fetchTracksByIds: (query: GetTracksByIdsQuery) => Promise<readonly Track[]>
  /**
   * R2's boundary policy where nothing more specific applies — the library
   * order, and anything played before a playlist has been chosen.
   *
   * The fallback for a controller with no `settings`. With one, `audio.crossfadeMs`
   * is the value — resolved at the playing playlist when there is one — and this
   * is ignored: a controller that snapshotted the setting here would be one where
   * changing the crossfade did nothing until relaunch.
   */
  crossfadeMs?: number
  /**
   * The audio device, for the one setting that is not the engine's to hold.
   *
   * Handed in beside `createEngine` because `audio.outputDevice` is a property
   * of the contexts the engine factory built, not of an engine slot — see
   * `audio/outputDevice.ts`. Omitting it is supported and means the system
   * default, which is what a test with a fake engine wants.
   */
  setOutputDevice?: (deviceId: string) => Promise<void>
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
   * The reactive settings surface — shuffle, repeat and the crossfade cascade.
   *
   * Read through rather than copied out: a change made in the settings view has
   * to reach the transport that is already playing, which is the whole of W8-4.
   * Omitting it is supported and means the modes last for the session and the
   * crossfade is whatever `crossfadeMs` said, which is what the tests want.
   *
   * Cascading rather than plain, because W8-5 made the playing playlist's
   * crossfade an override on `audio.crossfadeMs` rather than a number handed in
   * at play time. A reader that could not resolve one would leave this the last
   * place in the app carrying its own answer to "does this playlist play
   * differently?".
   */
  settings?: CascadingSettingsReader
  /**
   * The seed for a shuffle, drawn each time shuffle is switched on so that off
   * and on again reshuffles. Injected only so a test can assert a sequence.
   */
  createShuffleSeed?: () => number
  /**
   * How deep a session fill goes. Defaults to `SESSION_QUEUE_CAP`.
   *
   * Injected for the same reason `createShuffleSeed` is: the behaviour that
   * only appears past the cap — a drained session resuming after the last row
   * it materialized rather than at the anchor — is otherwise reachable only by
   * driving five thousand advances.
   */
  sessionQueueCap?: number
  /**
   * Called once per play, at the moment the transport commits to a track.
   *
   * The play-history trail's only route out of playback. A sink rather than a
   * store reached from in here, for the reason everything else in this file is
   * injected: the trail is a main-process table behind IPC, and a controller
   * that reached for it could not be driven under the node test config.
   *
   * Fire-and-forget by construction — it returns nothing and is never awaited.
   * Recording a play must not be able to delay, fail or reorder the audio that
   * caused it.
   */
  onPlayStarted?: (track: Track) => void
  /**
   * Called at *departure*, and only for a play that crossed the listened
   * threshold — D17's listens log, W10-4.
   *
   * The counterpart to `onPlayStarted` and deliberately not its twin. That one
   * fires once per play, unconditionally, because the trail records what the
   * transport did; this one fires at the other end of the play and only when
   * the accumulator says the track was actually listened to. A skipped track
   * reaches the first sink and never the second, which is the whole difference
   * between the two records.
   *
   * Fire-and-forget, for the same reason and with the same force.
   */
  onListenDeparted?: (listen: RecordListenRequest) => void
  /**
   * The listen accumulator's clock and seek epsilon. Injected only so a test
   * can assert a `startedAt` and drive a seek without a real one.
   */
  now?: () => number
  listenSeekEpsilonMs?: number
}

export interface PlayFromListParams {
  sort: TrackSortColumn
  direction: SortDirection
  filters?: LibraryBrowseFilters
  /**
   * The position the user asked for, or absent for "start this set".
   *
   * The two are not the same request and shuffle is where the difference
   * shows. See `startOrder`.
   */
  index?: number
  /**
   * The row the user clicked. Supplied so the panel can show a title
   * immediately instead of waiting on a round trip for a row the list already
   * had.
   */
  track?: Track
}

export interface PlayFromPlaylistParams {
  playlistId: number
  /** As with `PlayFromListParams.index`: absent means "start this playlist". */
  index?: number
  /** As with `PlayFromListParams.track`: the row the user actually clicked. */
  track?: Track
}

/**
 * My Favorites has no id to name, which is the whole of D18 showing up in a
 * parameter list: there is one such collection and the order over it is fixed,
 * so the position and the clicked row are all there is to say.
 */
export interface PlayFromFavoritesParams {
  /** As with `PlayFromListParams.index`: absent means "start My Favorites". */
  index?: number
  /** As with `PlayFromListParams.track`: the row the user actually clicked. */
  track?: Track
}

function normalizeCrossfadeMs(milliseconds: number | undefined): number {
  return Number.isFinite(milliseconds) && (milliseconds ?? 0) > 0 ? (milliseconds ?? 0) : 0
}

/**
 * The global crossfade as a two-way binding on `audio.crossfadeMs`.
 *
 * Wrapped rather than handed over raw so that R2's normalization applies to a
 * value arriving from the store — from another window, or from a build whose
 * descriptor allowed something this one does not — exactly as it applies to one
 * arriving from `setCrossfadeMs`.
 */
function bindCrossfadeMs(settings: SettingsReader): Ref<number> {
  const stored = settings.value<number>(AUDIO_CROSSFADE_MS_KEY)
  return computed({
    get: () => normalizeCrossfadeMs(stored.value),
    set: (milliseconds: number) => {
      stored.value = normalizeCrossfadeMs(milliseconds)
    }
  })
}

export function createPlaybackController(deps: PlaybackControllerDeps) {
  /**
   * D17's accumulator, and the departures that commit it.
   *
   * Held here rather than in the store for the same reason `onPlayStarted` is a
   * sink: the four signals that mean departure — a natural end, a new play, a
   * stop and a dispose — are all in this file, and a store watching `nowPlaying`
   * to infer them would be inferring from the one thing `retarget` restates for
   * a track that never left.
   */
  const listen = createListenRecorder({
    commit: (entry) => deps.onListenDeparted?.(entry),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.listenSeekEpsilonMs === undefined ? {} : { seekEpsilonMs: deps.listenSeekEpsilonMs })
  })

  const status = ref<PlaybackStatus>('idle')
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(1)
  /**
   * Bumped once each time the order plays through to its natural end — the
   * scheduler's `orderended`. A monotonic tick rather than a flag because what
   * a consumer wants is the *edge*: G2 returns the frame to the last view on
   * this transition and nowhere else, and a tick can be watched for that edge
   * without a reset it could race. Deliberately not derivable from `status`,
   * which a gapless boundary drives through `ended` transiently on its way to
   * the next track.
   */
  const endedNaturally = ref(0)
  /**
   * R2's fallback: what a boundary uses when no playlist is playing.
   *
   * Bound to `audio.crossfadeMs` when there is a settings surface to bind to, so
   * that setting it here and setting it in the settings view are the same act on
   * the same value. Normalized on the way in *and* on the way out: the stored
   * value has already been through the descriptor's validator, but a controller
   * that trusted that would still be a controller whose R2 contract depended on
   * somebody else's.
   */
  const defaultCrossfadeMs: Ref<number> = deps.settings
    ? bindCrossfadeMs(deps.settings)
    : ref(normalizeCrossfadeMs(deps.crossfadeMs))
  /**
   * What the scheduler actually gets: `audio.crossfadeMs` resolved at the
   * playing playlist, or the global value when nothing playlist-shaped is
   * playing.
   *
   * Derived from `playingPlaylistId` rather than held beside it, and resolved
   * through the cascade rather than handed in at play time. Both follow from
   * W8-5: there is one row that says how this playlist plays, and one function
   * that reads it. The two questions the old pair answered — "what does the
   * library use" and "what does this playlist use" — are the cascade's two
   * levels, and reverting the override is what gives the playlist the library's
   * answer back.
   *
   * A playlist whose overrides have not arrived yet resolves to the inherited
   * value and re-resolves when they do; the watch below pushes the change to a
   * boundary already scheduled.
   */
  const crossfadeMs = computed(() => {
    const playlistId = playingPlaylistId.value
    if (playlistId === null || !deps.settings) return defaultCrossfadeMs.value
    return normalizeCrossfadeMs(
      deps.settings.cascade(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: playlistId }).value
    )
  })
  /**
   * ReplayGain, R1's budgets, decode-ahead: read through, never snapshotted.
   *
   * `normalizationMode` used to be a plain `ref` seeded from a dep, which is
   * exactly the shape W8-4 rules out — the settings view could write
   * `audio.replayGainMode` and the playing track would not hear it. It is now a
   * projection of the three registry keys, and `setNormalizationMode` below
   * writes the key rather than the ref.
   */
  const audioPreferences = bindAudioPreferences(deps.settings)
  const normalizationPolicy = audioPreferences.normalization
  const normalizationMode = computed(() => normalizationPolicy.value.mode)
  const nowPlaying = ref<Track | null>(null)
  /**
   * R1's verdict on the audible track, mirrored into Vue.
   *
   * The scheduler's getter is not reactive — nothing under `audio/` knows what
   * Vue is, which is the point — so this is pulled across on the two events
   * that can follow an admission. Both are needed and neither is redundant:
   * `trackchange` covers the advance the scheduler makes on its own, and
   * `statuschange` covers the first load of a track started from the UI, where
   * the status leaves `loading` before any track is announced.
   */
  const admission = ref<R1AdmissionDecision | null>(null)
  const error = ref<string | null>(null)
  const prefetchStatus = ref<PrefetchStatus>('idle')
  const prefetchedTrackId = ref<number | null>(null)
  const prefetchError = ref<string | null>(null)

  /**
   * Where the playing track sits: its position in `order`, and whether it is
   * that row or a queue detour taken from it. `null` when idle.
   */
  const position = ref<SlotPosition | null>(null)

  /**
   * Position of the playing track within `order`, or `null` when idle.
   *
   * Under a queue track this is the row the queue interrupted rather than
   * anything about the queued track — §5 rule 2 says queueing never moves the
   * current position, and rule 1's second arm resumes from here once the queue
   * drains. Pair it with `playingQueueEntryId` before highlighting a row.
   */
  const orderIndex = computed(() => position.value?.index ?? null)

  /** The queue entry being played, or `null` when the order is being traversed. */
  const playingQueueEntryId = computed(() => position.value?.queueEntryId ?? null)

  /**
   * The transient up-next queue (§5). Owned here rather than in a store for the
   * same reason the rest of playback is: the seven rules are decidable without
   * Pinia, IPC or an `AudioEngine`, and a store that owned it would make them
   * testable only through one.
   *
   * Every edit re-decides the successor, because a boundary is usually armed
   * against a decoded track already — "play next" that only took effect from
   * the track after the one you were looking at would not be play-next.
   */
  const queue = createUpNextQueue({
    onChange: () => {
      scheduler?.queueChanged()
    }
  })

  /**
   * The playlist being traversed, or `null` when the order came from the
   * library list (§5 rule 3).
   *
   * The playing half of the split the §5 preamble insists on. Its counterpart,
   * `viewedPlaylistId`, lives in the playlists store and is deliberately not
   * reachable from here: the guarantee that browsing another tab disturbs
   * nothing is worth more as a structural fact than as a rule someone has to
   * remember. There is no code path in this file that could read it even by
   * mistake.
   */
  const playingPlaylistId = ref<number | null>(null)

  // Bound rather than read: assigning either one persists it, and a change made
  // anywhere else arrives here without anything having to be told about it.
  const { repeat: repeatMode, shuffle: shuffleEnabled } = bindTransportPreferences(deps.settings)

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

  /**
   * How the playing scope's rows are read in bulk, for the session tier.
   *
   * Built by whichever entry point started the order, because only it knows
   * what the scope *is* — the filters and sort for a library traversal, the
   * playlist id for a playlist one. `startOrder` is the one seam both go
   * through, so neither grows its own copy of the fill.
   */
  let sessionScope: SessionRowReader | null = null

  /**
   * The intent that produced the current order — G2's queue-restore, W14-6.
   *
   * Set by each play entry point to the discriminated fact it started from, so
   * `snapshotSession` can persist *what was asked for* rather than the rows it
   * derived. Cleared on stop and dispose, which is what makes a shut-down on an
   * idle transport snapshot to the empty session rather than resurrect a queue.
   * Held as a ref only so the persistence watcher in the store can react to it.
   */
  const currentIntent = ref<QueueIntent | null>(null)

  /**
   * A restored order waiting for its first play — the paused half of G2.
   *
   * `hydrateSession` installs the order, position and `nowPlaying` without
   * touching the audio device: startup is not a user gesture, and browser
   * autoplay policy only resumes the context during one. So the actual start is
   * deferred to the first `resume`, which finds this set and starts the order at
   * the saved index and elapsed rather than resuming an engine that was never
   * built. Cleared the moment it is consumed, and by any real play or stop that
   * overtakes it.
   */
  let pendingResume: { index: number; elapsedMs: number } | null = null

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
      queue,
      crossfadeMs: crossfadeMs.value,
      normalizationPolicy: normalizationPolicy.value,
      decodePolicy: audioPreferences.decodePolicy.value,
      prefetchDepth: audioPreferences.prefetchDepth.value,
      repeatMode: repeatMode.value
    })
    unsubscribes = [
      created.on('statuschange', (next) => {
        status.value = next
        admission.value = created.admission
        // Leaving `playing` drops the accumulator's baseline, so a pause, a
        // seek and a resume cannot be credited as the gap between them. The
        // position is not read when the state is not `playing`, which is why
        // this does not have to care that `currentTime` may be frozen by a
        // scrub in progress.
        if (next !== 'playing') listen.observe(currentTime.value * 1000, false)
      }),
      created.on('timeupdate', (position) => {
        duration.value = position.duration
        if (!scrubbing.value) currentTime.value = position.currentTime
        // The *engine's* position, not `currentTime` — which a drag in progress
        // deliberately holds still, and which during that drag is the scrub
        // handle rather than what is audible. Feeding the handle would credit
        // scrubbing through a track as listening to it, which is the exact
        // thing Last.fm's rule exists to prevent.
        listen.learn(position.duration * 1000)
        listen.observe(position.currentTime * 1000, status.value === 'playing')
      }),
      created.on('error', (err) => {
        error.value = err.message
      }),
      created.on('trackchange', ({ track, position: at }) => {
        nowPlaying.value = track
        position.value = at
        admission.value = created.admission
      }),
      // The last track of an order ends and nothing follows it: no `playstart`
      // comes, so this is the only departure that play will ever get. At a
      // boundary with a successor it fires first and `playstart` finds nothing
      // left to depart — see the recorder on why that ordering is not relied on.
      created.on('ended', () => {
        listen.depart()
      }),
      // G2's played-through signal. Distinct from `ended`, which fires at every
      // boundary including those a successor follows; this fires only when the
      // order stops here of its own accord.
      created.on('orderended', () => {
        endedNaturally.value += 1
      }),
      created.on('playstart', ({ track }) => {
        deps.onPlayStarted?.(track)
        // Departs the outgoing track before the incoming one begins. This is
        // the skip, the Next, the jump-back and the ordinary boundary, all of
        // which reach the transport as one track replacing another.
        listen.begin(track)
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
   * Moves to a place in the traversal and plays what is there.
   *
   * `position` is written *before* the lookup is awaited so that two fast
   * presses of Next advance two rows — and, with a queue, consume two entries.
   * Reading it after the await would have both presses compute the same target.
   */
  async function goToPosition(at: SlotPosition, queued?: QueueEntry): Promise<void> {
    if (!order || !scheduler) return

    const token = ++requestToken
    const previous = position.value
    position.value = at

    // Dropped *before* the move rather than after it: `goTo` arms the
    // decode-ahead on its way out, and a tier that is about to be replaced
    // would have it warm a row that is not going to play next. Refilled once
    // the move has landed, when the anchor it describes is settled.
    const stale = sessionIsStale(at)
    if (stale) queue.clearSession()

    try {
      const track = queued ? await scheduler.goToQueued(queued, at) : await scheduler.goTo(at.index)
      if (token !== requestToken || track === undefined) return
      if (!track) {
        // Off the end of the order. The scheduler has paused the current track.
        position.value = previous
        return
      }
      if (stale) void fillSession(at.index)
    } catch {
      if (token === requestToken) {
        position.value = previous
        if (!error.value) error.value = 'Could not read the next track.'
      }
    }
  }

  /** Dispatches whichever arm of §5 rule 1 named this successor. */
  async function goToSuccessor(successor: Successor): Promise<void> {
    if (successor.kind === 'queue') {
      // §5 rule 1's shift, and it is synchronous on purpose: the decode the
      // scheduler adopts is chosen inside an await, so a second Next arriving
      // before that resolves must find the head already gone or both presses
      // play the same row.
      queue.take(successor.entry.id)
      await goToPosition(successor.position, successor.entry)
      return
    }
    await goToPosition(successor.position)
  }

  /**
   * Adopts an ordering and starts one of its rows.
   *
   * Shared by both entry points on purpose. Shuffle, repeat and the length
   * capture are properties of *a* `PlayOrder`, not of where it came from, so a
   * playlist gets all three by handing one in — and there is no second copy of
   * this sequence to drift from the first when the queue lands in W5-5.
   *
   * ## `at` of `null`: starting a set rather than a row
   *
   * "Play this row" and "play this playlist" are different requests, and under
   * shuffle they have different right answers. A named row is pinned to the
   * front of the permutation, because "shuffle is on" must never mean "the row
   * I clicked is not what plays". A set names no row — the rail's Play, a
   * double-clicked artist — and pinning position 0 there is what made shuffle
   * play the first track of every playlist and shuffle only what came after it.
   * Unpinned, the permutation chooses the opener like any other position; if it
   * chooses position 0 that is a shuffle result rather than a rule.
   *
   * The cost is one round trip: an unpinned position 0 resolves through the
   * permutation, which needs the order's length, where a pinned one does not.
   * That is paid only by the gestures that have no row in hand anyway, and they
   * are exactly the ones with no title to show while it resolves.
   */
  async function startOrder(
    base: PlayOrder,
    at: number | null,
    scope: SessionRowReader,
    track?: Track,
    options?: { autostart?: boolean; resumeElapsedMs?: number }
  ): Promise<void> {
    // A real start supersedes any queue that was waiting to be resumed. Set
    // before anything else so an autostart path can never leave a stale one
    // behind for the next `resume` to act on.
    pendingResume = null
    baseOrder = base
    sessionScope = scope

    // The pin resolves without the permutation, so an anchored start costs the
    // click path nothing — the length query and the shuffle itself happen while
    // the track is already decoding.
    shuffledOrder = shuffleEnabled.value
      ? createShuffledPlayOrder(base, {
          seed: shuffleSeed(),
          ...(at === null ? {} : { pinnedBaseIndex: at })
        })
      : null
    order = shuffledOrder ?? base
    const index = shuffledOrder ? 0 : (at ?? 0)
    // A row handed in is the row at `at`, so it is only the opener while `at`
    // is what position 0 resolves to. Unpinned shuffle is the one case where it
    // is not, and showing it would put a title on screen that the permutation
    // is about to disagree with. Guarded here rather than at the call sites,
    // because "supply the row you clicked" is advice a later caller will follow
    // without knowing this.
    const opener = shuffledOrder && at === null ? undefined : track
    captureTotal()
    // Before the first play there is no scheduler; `ensureScheduler` reads the
    // effective value at construction and so picks the same one up.
    applyCrossfade()

    ++requestToken
    error.value = null

    // §5 rule 3 as amended: the session tier describes the session that is
    // ending, so it goes now rather than when its replacement arrives — an
    // up-next surface showing the *previous* scope for the length of a fill
    // would be worse than one showing nothing. The user tier survives, which is
    // the whole of what the split protects.
    queue.clearSession()

    // With the row already in hand there is nothing to look up, so skip
    // `goToPosition` and its round trip.
    if (opener) {
      position.value = orderPosition(index)
      nowPlaying.value = opener
    }

    // The paused-hydrate path (G2 queue-restore): everything above installs the
    // order, position and now-playing row, but the audio device stays untouched
    // — no `ensureScheduler`, no gesture spent — until the operator presses play
    // and `resume` finds the `pendingResume` this leaves. The session tier is
    // still filled so the up-next surface is populated for a queue nobody has
    // started yet.
    if (options?.autostart === false) {
      pendingResume = { index, elapsedMs: Math.max(0, options.resumeElapsedMs ?? 0) }
      void fillSession(index)
      return
    }

    // Deliberately not awaited. `startAt` is the click path and the fill is
    // five round trips behind it; making the audio wait on the queue being
    // drawable would trade the thing the user asked for against a list.
    void fillSession(index)
    await startAt(index, opener)
  }

  /**
   * Whether the session tier would stop describing the rows after the anchor if
   * the position moved to `at`.
   *
   * The tier is a function of an order and a position, and consuming its head
   * moves both together — take the entry at order row 3 and the new head is row
   * 4 against an anchor of 3, which is exactly what this asks for. So ordinary
   * traversal, a user detour and a jump all pass without a refill.
   *
   * Previous is what does not: stepping back to row 1 leaves a tier whose head
   * is row 3, and the next advance would take that head and skip row 2
   * outright. Written as the invariant rather than patched into Previous, so a
   * later mover cannot quietly reintroduce it.
   *
   * A tier that has *drained* is not stale. That distinction is load-bearing:
   * an empty tier is the capped session the amendment's anchor rule is about,
   * and refilling it here would turn the cap into an unbounded queue.
   */
  function sessionIsStale(at: SlotPosition): boolean {
    const head = queue.sessionEntries.value[0]
    if (!head) return false
    return head.orderIndex !== at.index + 1
  }

  /**
   * Materializes the scope behind the anchor into the session tier.
   *
   * Guarded on the *order object* rather than on `requestToken`, which is the
   * one place this file departs from its usual generation check and is worth
   * the sentence: a session tier is a property of an order, and `requestToken`
   * also moves on every Next. Guarding on the token would abandon a fill
   * because the user skipped a track while it was in flight — leaving the queue
   * empty for exactly the operator who is using it. Every way of getting a
   * different session — either entry point, and a shuffle toggle — installs a
   * new order object, so identity is both sufficient and more precise.
   */
  async function fillSession(anchor: number): Promise<void> {
    const captured = order
    const scope = sessionScope
    if (!captured || !scope) return

    const shuffled = shuffledOrder
    try {
      const rows = await materializeSession({
        read: scope,
        baseIndexAt: shuffled
          ? (index) => shuffled.baseIndexAt(index)
          : (index) => Promise.resolve(index),
        from: anchor + 1,
        limit: Math.max(0, deps.sessionQueueCap ?? SESSION_QUEUE_CAP)
      })
      // A newer order was started while this was in flight; its session is not
      // this one's.
      if (order !== captured) return
      queue.fillSession(rows)
    } catch {
      // A scope that could not be read costs the operator a visible queue and
      // nothing else — traversal still resolves each position on its own. Left
      // silent rather than surfaced through `error`, which is the transport's
      // channel for "the music stopped".
    }
  }

  /**
   * Starts a track from the track list, capturing the list's ordering as the
   * play order. See the note in `playOrder.ts` on why it is a snapshot.
   */
  async function playFromList(params: PlayFromListParams): Promise<void> {
    // The library order is not a playlist, so the crossfade reverts to the
    // global setting rather than keeping whatever the last playlist wanted.
    // Clearing the id is the whole of that now: `crossfadeMs` derives from it.
    playingPlaylistId.value = null
    currentIntent.value = {
      kind: 'list',
      sort: params.sort,
      direction: params.direction,
      ...(params.filters ? { filters: params.filters } : {})
    }

    await startOrder(
      createListPlayOrder({
        fetchPage: deps.fetchPage,
        sort: params.sort,
        direction: params.direction,
        filters: params.filters
      }),
      params.index ?? null,
      // The same three facts the order was built from. That is the point of the
      // session tier: the scope has always bounded traversal, and this is it
      // read in bulk rather than one position at a time.
      libraryScopeReader({
        fetchTrackIds: deps.fetchTrackIds,
        fetchTracksByIds: deps.fetchTracksByIds,
        sort: params.sort,
        direction: params.direction,
        filters: params.filters
      }),
      params.track
    )
  }

  /**
   * Starts a track from My Favorites, traversing `track_favorites` — **D18**.
   *
   * `playingPlaylistId` clears, exactly as it does for the library order and for
   * the same reason: this is not a playlist, so there is no per-playlist
   * crossfade to keep and §5 rule 3 does not apply to it. The pinned rail entry
   * is a view over a table, and playing it plays a collection rather than
   * entering a playlist.
   */
  async function playFromFavorites(params: PlayFromFavoritesParams): Promise<void> {
    playingPlaylistId.value = null
    currentIntent.value = { kind: 'favorites' }

    await startOrder(
      createFavoritesPlayOrder({ fetchPage: deps.fetchFavorites }),
      params.index ?? null,
      favoritesScopeReader({ fetchPage: deps.fetchFavorites }),
      params.track
    )
  }

  /**
   * Starts a track from a playlist, traversing that playlist's entries.
   *
   * §5 rule 3: this is what sets `playingPlaylistId`, and it is the only thing
   * that does. Viewing a tab does not, which is the whole point of the split.
   */
  async function playFromPlaylist(params: PlayFromPlaylistParams): Promise<void> {
    playingPlaylistId.value = params.playlistId
    currentIntent.value = { kind: 'playlist', playlistId: params.playlistId }
    // Started rather than awaited: a playlist should not wait on a settings read
    // to begin playing, and until it lands `crossfadeMs` resolves to what the
    // playlist inherits — which is the right answer if it has no override, and
    // replaced reactively the moment the rows arrive if it has.
    void deps.settings?.loadOverrides({ kind: 'playlist', id: params.playlistId })

    await startOrder(
      createPlaylistPlayOrder({
        playlistId: params.playlistId,
        fetchEntries: deps.fetchPlaylistEntries
      }),
      params.index ?? null,
      playlistScopeReader({
        playlistId: params.playlistId,
        fetchEntries: deps.fetchPlaylistEntries
      }),
      params.track
    )
  }

  /**
   * Plays a finite list of already-resolved rows (podcast episodes today).
   *
   * Not a playlist: `playingPlaylistId` clears, and the order is the rows
   * themselves rather than another round trip per position. Caller downloads
   * first — the engine only resolves `oscine://episode/<id>` for files on disk.
   */
  async function playTracks(params: { tracks: readonly Track[]; index: number }): Promise<void> {
    if (params.tracks.length === 0) return
    const index = Math.max(0, Math.min(params.index, params.tracks.length - 1))
    const track = params.tracks[index]
    if (!track) return

    playingPlaylistId.value = null

    const orderTracks = [...params.tracks]
    currentIntent.value = { kind: 'tracks', trackIds: orderTracks.map((row) => row.id) }
    await startOrder(
      createFixedPlayOrder(orderTracks, `podcast:${orderTracks.map((row) => row.id).join(',')}`),
      index,
      async (baseIndices) => {
        const rows = new Map<number, Track>()
        for (const baseIndex of baseIndices) {
          const row = orderTracks[baseIndex]
          if (row) rows.set(baseIndex, row)
        }
        return rows
      },
      track
    )
  }

  /**
   * Rebuilds the order and session scope an intent describes — G2's restore.
   *
   * The mirror of the four play entry points above, collected in one place so
   * that what `snapshotSession` records and what a restore rebuilds cannot drift
   * apart unremarked. `null` for an intent that resolves to nothing — a `tracks`
   * list whose episodes have all left the library. Async only because that one
   * variant fetches its rows before it can order them; the paged three resolve a
   * row at a time exactly as their live counterparts do.
   *
   * `indexOf` is supplied only for `tracks`, whose whole order is materialized
   * here and so can be searched for the current row after some of it has gone
   * missing. The paged orders trust the saved base index instead — locating a
   * track in one is a scan the live app never performs either.
   */
  async function intentToOrder(intent: QueueIntent): Promise<{
    base: PlayOrder
    scope: SessionRowReader
    playlistId: number | null
    indexOf?: (trackId: number) => number
  } | null> {
    switch (intent.kind) {
      case 'list':
        return {
          base: createListPlayOrder({
            fetchPage: deps.fetchPage,
            sort: intent.sort,
            direction: intent.direction,
            filters: intent.filters
          }),
          scope: libraryScopeReader({
            fetchTrackIds: deps.fetchTrackIds,
            fetchTracksByIds: deps.fetchTracksByIds,
            sort: intent.sort,
            direction: intent.direction,
            filters: intent.filters
          }),
          playlistId: null
        }
      case 'favorites':
        return {
          base: createFavoritesPlayOrder({ fetchPage: deps.fetchFavorites }),
          scope: favoritesScopeReader({ fetchPage: deps.fetchFavorites }),
          playlistId: null
        }
      case 'playlist':
        return {
          base: createPlaylistPlayOrder({
            playlistId: intent.playlistId,
            fetchEntries: deps.fetchPlaylistEntries
          }),
          scope: playlistScopeReader({
            playlistId: intent.playlistId,
            fetchEntries: deps.fetchPlaylistEntries
          }),
          playlistId: intent.playlistId
        }
      case 'tracks': {
        const rows = await deps.fetchTracksByIds({ ids: intent.trackIds })
        const byId = new Map(rows.map((row) => [row.id, row]))
        // Preserve the saved order, dropping any episode that has since gone.
        const orderTracks = intent.trackIds
          .map((id) => byId.get(id))
          .filter((row): row is Track => row !== undefined)
        if (orderTracks.length === 0) return null
        return {
          base: createFixedPlayOrder(
            orderTracks,
            `podcast:${orderTracks.map((row) => row.id).join(',')}`
          ),
          scope: async (baseIndices) => {
            const out = new Map<number, Track>()
            for (const baseIndex of baseIndices) {
              const row = orderTracks[baseIndex]
              if (row) out.set(baseIndex, row)
            }
            return out
          },
          playlistId: null,
          indexOf: (trackId) => orderTracks.findIndex((row) => row.id === trackId)
        }
      }
    }
  }

  /**
   * The current queue as a persistable session, or the empty one when idle.
   *
   * Async only because a shuffled position has to be mapped back to its base
   * index: the snapshot is stored against the un-shuffled order, so a restore
   * under shuffle pins the same current track and reshuffles what follows rather
   * than claiming a permutation it never persisted. Everything else is a plain
   * read of state the transport already holds.
   */
  async function snapshotSession(): Promise<QueueSession> {
    const intent = currentIntent.value
    const track = nowPlaying.value
    if (!intent || !track) return { ...EMPTY_QUEUE_SESSION }

    const orderIdx = position.value?.index ?? 0
    const baseIndex = shuffledOrder ? await shuffledOrder.baseIndexAt(orderIdx) : orderIdx
    return {
      intent,
      baseIndex: Math.max(0, baseIndex ?? orderIdx),
      trackId: track.id,
      elapsedMs: Math.max(0, Math.round(currentTime.value * 1000))
    }
  }

  /**
   * Installs a restored queue, paused at its saved position — G2's launch half.
   *
   * Refuses to act once anything is already loaded: a media key pressed during
   * startup, or a track the operator started before the restore resolved, both
   * win over a session from last time — hence the guard before *and* after the
   * two awaits. The current track is fetched by id first, and its absence — an
   * episode deleted, a file moved out of the library — drops the whole restore
   * rather than resuming onto whatever row now sits at the saved index.
   */
  async function hydrateSession(session: QueueSession): Promise<void> {
    const intent = session.intent
    if (!intent || session.trackId === null) return
    if (order || nowPlaying.value) return

    const built = await intentToOrder(intent)
    if (!built) return

    const [opener] = await deps.fetchTracksByIds({ ids: [session.trackId] })
    if (!opener) return
    if (order || nowPlaying.value) return

    let index = session.baseIndex
    if (built.indexOf) {
      const found = built.indexOf(session.trackId)
      if (found < 0) return
      index = found
    }

    // A restored playlist resolves its crossfade override the same way a live
    // one does; without this the first boundary would use the global value.
    if (intent.kind === 'playlist') {
      void deps.settings?.loadOverrides({ kind: 'playlist', id: intent.playlistId })
    }

    playingPlaylistId.value = built.playlistId
    currentIntent.value = intent
    await startOrder(built.base, index, built.scope, opener, {
      autostart: false,
      resumeElapsedMs: session.elapsedMs
    })
  }

  /**
   * §5 rule 4, second half: deleting the playing playlist stops playback.
   *
   * Called by whatever performed the deletion rather than watched for, because
   * "the playlist is gone" is an event and the controller holds no subscription
   * to main. A deletion of any other playlist is not this controller's business
   * — including one a queued track came from, which is rule 4's first half and
   * explicitly leaves playback alone.
   */
  function playlistDeleted(playlistId: number): void {
    if (playingPlaylistId.value !== playlistId) return
    stop()
  }

  async function next(): Promise<void> {
    const from = position.value
    if (!from) return
    // Decided from the cached length rather than a fresh count, and entirely
    // synchronously, for the reason `goToPosition` gives. Repeat-one is
    // deliberately not honoured here: pressing Next under it moves on, as it
    // does in every player anyone has used. See `traversal.ts`.
    const successor = chooseSuccessor({
      from,
      head: queue.head(),
      total: orderTotal.value,
      repeat: repeatMode.value,
      reason: 'explicit'
    })
    if (successor === null) {
      // The end of the order with nothing to wrap to and nothing queued.
      // Pausing is what `goToPosition` does on finding no row there, and doing
      // it here as well keeps the clean stop from depending on whether the
      // length happened to be known.
      pause()
      return
    }
    await goToSuccessor(successor)
  }

  /**
   * Plays a queued entry now, out of turn — and what that costs depends on the
   * tier.
   *
   * A **user** entry keeps W5-5's decision: only that entry leaves the queue.
   * Dropping everything above it is the other plausible reading of a jump and
   * §5 does not choose, so this takes the one that destroys nothing.
   *
   * A **session** entry is an order row, and jumping to one moves the anchor to
   * it. The session rows above it go with the jump, because they are behind the
   * operator now — keeping them would replay the scope from where the jump
   * started. The user tier is untouched either way: it sits above the session
   * tier and is not behind anything.
   */
  async function playQueued(entryId: string): Promise<void> {
    const from = position.value
    const entry = queue.entry(entryId)
    if (!from || !entry) return
    // The same synchronous shift `next` performs, for the same reason.
    queue.takeThrough(entry.id)
    await goToPosition(
      {
        index: entry.orderIndex ?? from.index,
        queueEntryId: entry.id,
        queueOrigin: entry.origin
      },
      entry
    )
  }

  /**
   * Jump back to a track off the play-history trail (W7-4).
   *
   * **A detour, not a change of scope.** The row goes to the head of the user
   * tier and is played out of turn, which makes it §5 rule 1's first arm and
   * nothing more: `playingPlaylistId` does not move (rule 3 is about *playing
   * from* a playlist, and this plays from the trail), the anchor does not move
   * because a user entry carries no `orderIndex` of its own, and the session
   * tier is not stale by `sessionIsStale`'s reckoning because the anchor it is
   * measured against is unchanged. When the jumped-back track ends, rule 1's
   * second arm resumes at the row that was interrupted. Nothing about what is
   * playing changes except that one track cuts in front of it.
   *
   * Deliberately not "re-enter the scope this played from at the position it
   * played at". That reading would set `playingPlaylistId`, rebuild the order
   * and replace the session tier — a jump back to something heard twenty
   * minutes ago would silently discard the queue the operator has built since —
   * and it would need a scope stored per row that goes stale the moment a
   * playlist is edited. It is also not what "go back" means to anyone who just
   * wanted to hear a thing again.
   *
   * With nothing playing there is no detour to take and no position to resume,
   * so this starts a one-track order instead — which is the state the trail is
   * in immediately after a restart, and the trail survives restarts.
   */
  async function replay(track: Track): Promise<void> {
    if (position.value === null) {
      await playTracks({ tracks: [track], index: 0 })
      return
    }
    const [entry] = queue.enqueueNext([track])
    if (!entry) return
    await playQueued(entry.id)
  }

  async function previous(): Promise<void> {
    // At the first row there is nowhere to go without repeat. Restarting the
    // current track instead is a convention worth having, but it belongs with
    // the rest of the transport polish rather than smuggled in here.
    const from = position.value
    if (!from) return
    // Backing out of a *user* detour returns to the row it interrupted. The
    // queue is forward-looking — the entry that just played has been shifted
    // out of it — so there is nothing else Previous could mean there.
    //
    // A session entry is not a detour: it *is* the order row at `from.index`,
    // so returning to that row would replay what is playing. It falls through
    // to the ordinary step back, which is why the tier is on the position at
    // all — by now the entry itself is gone from the queue.
    if (from.queueEntryId !== null && from.queueOrigin !== 'session') {
      await goToPosition(orderPosition(from.index))
      return
    }
    const index = previousIndex(from.index, orderTotal.value, repeatMode.value)
    if (index === null) return
    await goToPosition(orderPosition(index))
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
    // The assignment is the persistence: `repeatMode` is the setting.
    repeatMode.value = mode
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
    // As with `setRepeatMode`: the assignment is the persistence.
    shuffleEnabled.value = enabled

    const base = baseOrder
    const at = position.value
    if (!base || !order || at === null || !scheduler) return
    const token = ++shuffleToken
    // §5 rule 6 as amended: shuffle permutes the playing order and never the
    // *user* tier. What moves here is the anchor — a detour keeps its identity
    // across a reshuffle of the rows it will come back to.
    const rebase = (index: number): SlotPosition => ({
      index,
      queueEntryId: at.queueEntryId,
      ...(at.queueOrigin ? { queueOrigin: at.queueOrigin } : {})
    })

    let anchor: number
    if (enabled) {
      const shuffled = createShuffledPlayOrder(base, {
        seed: shuffleSeed(),
        pinnedBaseIndex: at.index
      })
      shuffledOrder = shuffled
      order = shuffled
      anchor = 0
      position.value = rebase(anchor)
      scheduler.retarget(shuffled, anchor)
    } else {
      const resumeAt = (await shuffledOrder?.baseIndexAt(at.index)) ?? at.index
      if (token !== shuffleToken) return
      shuffledOrder = null
      order = base
      anchor = resumeAt
      position.value = rebase(anchor)
      scheduler.retarget(base, anchor)
    }

    captureTotal()
    // The other half of rule 6 as amended: the session tier is *refilled*,
    // because it is the tier that claims to describe what is actually going to
    // play. Leaving it would show an order that will not happen — which is the
    // one thing a visible queue must never do.
    queue.clearSession()
    void fillSession(anchor)
  }

  async function toggleShuffle(): Promise<void> {
    await setShuffle(!shuffleEnabled.value)
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
    // The paused-hydrate path (G2): a restored queue has an order and a
    // now-playing row but no engine yet. This first resume is the user gesture
    // finally allowed to build one, so it starts the order at the saved index
    // rather than resuming a device that was never opened.
    if (pendingResume && !scheduler) {
      const target = pendingResume
      pendingResume = null
      await startAt(target.index, nowPlaying.value ?? undefined)
      if (target.elapsedMs > 0) {
        const seconds = target.elapsedMs / 1000
        currentTime.value = seconds
        // Straight to the engine `startAt` has now built, which clamps to the
        // real track length: `seek` would clamp to `duration.value`, and the
        // first `timeupdate` that sets it has not arrived yet.
        ensureScheduler().seek(seconds)
      }
      return
    }
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

  /** Pushes whichever of the two crossfade settings currently applies. */
  function applyCrossfade(): void {
    scheduler?.setCrossfadeMs(crossfadeMs.value)
  }

  /**
   * The live half of W8-4, for the one setting that has to act mid-track.
   *
   * `setCrossfadeMs` pushes its own change, but it is no longer the only way one
   * arrives: the settings view writes the key directly, and so does another
   * window. The scheduler applies a new value at the next boundary rather than
   * to the boundary it is already in — which is what "changing crossfade
   * mid-track changes the next boundary" means, and why this needs no restart.
   */
  const stopCrossfadeWatch = watch(crossfadeMs, applyCrossfade)

  /**
   * Sets the global boundary policy.
   *
   * Takes effect immediately only when no playlist is playing; under one, the
   * playlist's own value keeps winning and this is what the next library
   * traversal will find.
   */
  function setCrossfadeMs(milliseconds: number): void {
    defaultCrossfadeMs.value = normalizeCrossfadeMs(milliseconds)
    applyCrossfade()
  }

  /**
   * Sets `audio.replayGainMode`, and lets the watch do the pushing.
   *
   * The assignment is the persistence, as it is for repeat: there is no second
   * place holding the mode, so a change made here and a change made in the
   * settings view are the same act on the same row. Without a settings surface
   * the binding is a plain ref and this still works for the session.
   */
  function setNormalizationMode(mode: NormalizationMode): void {
    audioPreferences.mode.value = mode
  }

  /**
   * The rest of W8-4's live half.
   *
   * Three watches rather than one, because the three land in different places:
   * loudness ramps the playing source, R1's budgets apply at the next
   * admission, and decode-ahead is taken away or given back immediately. A
   * single watch would have to push all three whenever any one moved, and
   * pushing a decode policy is not free.
   */
  const stopNormalizationWatch = watch(normalizationPolicy, (policy) => {
    scheduler?.setNormalizationPolicy(policy)
  })
  const stopDecodePolicyWatch = watch(audioPreferences.decodePolicy, (policy) => {
    scheduler?.setDecodePolicy(policy)
  })
  const stopPrefetchDepthWatch = watch(audioPreferences.prefetchDepth, (depth) => {
    scheduler?.setPrefetchDepth(depth)
  })
  /**
   * Immediate, unlike the other three: the router has to be told the stored
   * device at startup, not only when it next changes. Nothing is playing yet, so
   * there is no ramp to coordinate — the contexts are simply built pointing at
   * the right place, and one that has not been built yet is caught by `adopt`.
   */
  const stopOutputDeviceWatch = watch(
    audioPreferences.outputDevice,
    (deviceId) => {
      void deps.setOutputDevice?.(deviceId)
    },
    { immediate: true }
  )

  /** Stop playback and invalidate current and prefetched work. */
  function stop(): void {
    // Before the scheduler, which is what makes this a departure at all: a
    // `stop()` that had already torn the engine down would be a listen with
    // nothing left to commit it.
    listen.depart()
    requestToken++
    shuffleToken++
    scheduler?.stop()
    order = null
    // The orders go; the modes stay. Shuffle and repeat are settings, and
    // stopping is not a request to change one.
    baseOrder = null
    shuffledOrder = null
    sessionScope = null
    // The queue is gone, so the intent that named it goes too — a stop snapshots
    // to the empty session, which is what keeps a quit on a stopped transport
    // from resurrecting a queue next launch. Any pending restore is moot.
    currentIntent.value = null
    pendingResume = null
    // The session tier describes a traversal that has just ended, so it ends
    // with it. The user tier is not a property of any traversal and survives —
    // rule 3 as amended, and the same asymmetry `startOrder` applies.
    queue.clearSession()
    orderTotal.value = null
    position.value = null
    // Goes with the order rather than with the modes: which playlist is
    // playing — and so whose crossfade applies — is a fact about the traversal
    // that has just ended.
    playingPlaylistId.value = null
    nowPlaying.value = null
    admission.value = null
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
    // The last departure there will ever be, and the reason it is first: every
    // line below this one removes something the commit would have needed.
    listen.depart()
    mediaSession?.dispose()
    stopCrossfadeWatch()
    stopNormalizationWatch()
    stopDecodePolicyWatch()
    stopPrefetchDepthWatch()
    stopOutputDeviceWatch()
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
    sessionScope = null
    // Not `currentIntent`: a quit persists the last snapshot through the store's
    // flush hook, and that read must still find the intent the teardown is about
    // to make moot. The order is gone, so nothing will start from it regardless.
    pendingResume = null
    orderTotal.value = null
    status.value = 'idle'
    admission.value = null
    applyPrefetch({
      status: 'idle',
      index: null,
      queueEntryId: null,
      trackId: null,
      transitionPolicy: null,
      error: null
    })
  }

  return {
    status,
    endedNaturally,
    currentTime,
    duration,
    volume,
    crossfadeMs,
    defaultCrossfadeMs,
    normalizationMode,
    /**
     * The whole loudness policy, not just its mode.
     *
     * The transport only ever needed the mode. The signal readout has to say
     * which gain is *actually applied*, and that is `resolveNormalization`'s
     * answer given the pre-amp and the untagged-track fallback as well — so it
     * needs the same value the scheduler was handed, or it would describe a
     * different decision from the audible one.
     */
    normalizationPolicy,
    nowPlaying,
    /** R1's verdict on the audible track. See the ref for why it is mirrored. */
    admission,
    orderIndex,
    orderTotal,
    playingPlaylistId,
    playingQueueEntryId,
    queuedEntries: queue.entries,
    queuedCount: queue.count,
    /**
     * The tiers, separately.
     *
     * The transport badge counts `queuedUserCount` and not `queuedCount`: a
     * badge reading `312` after every click is noise, and the state it exists
     * to make visible — "a non-empty queue changes what Next does" — is a
     * statement about the tier the operator built by hand.
     */
    queuedUserEntries: queue.userEntries,
    queuedUserCount: queue.userCount,
    queuedSessionEntries: queue.sessionEntries,
    queuedSessionCount: queue.sessionCount,
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
    playFromPlaylist,
    playFromFavorites,
    playTracks,
    playlistDeleted,
    enqueue: queue.enqueue,
    enqueueNext: queue.enqueueNext,
    removeQueued: queue.remove,
    moveQueued: queue.move,
    /** Clears the hand-queued rows, leaving the playing scope's standing. */
    clearUserQueue: queue.clearUser,
    clearQueue: queue.clear,
    /** Plays a queued entry now, shifting it out of the queue (§5 rule 1). */
    playQueued,
    /** Jump-back off the play-history trail. A detour — see the function. */
    replay,
    next,
    previous,
    resume,
    pause,
    toggle,
    /**
     * G2's queue-restore, W14-6. `snapshotSession` reads the current queue as a
     * persistable intent-plus-position; `hydrateSession` installs a saved one
     * paused, to be started by the first `resume`. Both are gated by
     * `view.restoreQueue` in `usePlaybackStore`, which owns the persistence.
     */
    snapshotSession,
    hydrateSession,
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
    /**
     * Time-domain samples of the audible track, for the waveform ribbon.
     *
     * Not reactive, and deliberately so. This is polled from a render loop at
     * frame rate; routing it through a ref would push a fresh array into Vue's
     * dependency graph sixty times a second and invalidate every watcher in the
     * transport along with it. False when no engine has been claimed yet — the
     * device is not opened until the first play.
     */
    readWaveform: (into: WaveformBuffer): boolean => scheduler?.readWaveform(into) ?? false,
    /**
     * Departs the in-flight listen without stopping playback — the quit path.
     *
     * `dispose` would do it too, but quitting is not the only thing that could
     * ask and tearing the engine down to write a row would make the app
     * silent for however long the shutdown takes. Playback is untouched: the
     * accumulator simply has nothing in it afterwards, so a track that keeps
     * playing past this point earns a second listen from where it stands, which
     * is the honest answer to a flush that turned out not to precede a quit.
     */
    flushListen: (): void => {
      listen.depart()
    },
    dispose,
    /** Test seam: whether the audio device has actually been claimed yet. */
    hasEngine: (): boolean => scheduler !== null,
    /** Test seam: the OS media-session binding, or `null` when unbound. */
    mediaSession: (): MediaSessionBinding | null => mediaSession,
    /** Test seam: the ordering currently being played through. */
    orderId: (): string | null => order?.id ?? null,
    /**
     * Test seam: the boundary policy the scheduler will actually apply, as
     * opposed to the one the controller believes applies. The card's claim is
     * about what the scheduler reads, so that is what gets asserted.
     */
    schedulerCrossfadeMs: (): number | null => scheduler?.crossfadeMs ?? null,
    /**
     * Test seams for the other three live audio settings, and the same argument
     * as `schedulerCrossfadeMs`: the claim W8-9 makes is about what the
     * scheduler ends up holding, not about what the controller believes.
     */
    schedulerNormalizationPolicy: (): NormalizationPolicy | null =>
      scheduler?.normalizationPolicy ?? null,
    schedulerPrefetchDepth: (): number | null => scheduler?.prefetchDepth ?? null
  }
}

export type PlaybackController = ReturnType<typeof createPlaybackController>
