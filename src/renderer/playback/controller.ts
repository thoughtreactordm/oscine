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
  type PlaybackStatus
} from '../audio/AudioEngine'
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
import type { ListPlaylistEntriesQuery, ListPlaylistEntriesResult } from '@shared/playlists'
import { AUDIO_CROSSFADE_MS, AUDIO_CROSSFADE_MS_KEY } from '@shared/settings'
import type { MediaSessionBinding, MediaSessionState, MediaSessionTransport } from './mediaSession'
import {
  createFixedPlayOrder,
  createListPlayOrder,
  createPlaylistPlayOrder,
  type PlayOrder
} from './playOrder'
import { PlaybackScheduler, type PrefetchState, type PrefetchStatus } from './scheduler'
import {
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

export interface PlayFromPlaylistParams {
  playlistId: number
  index: number
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
  const status = ref<PlaybackStatus>('idle')
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(1)
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
  const normalizationMode = ref<NormalizationMode>(deps.normalizationMode ?? 'track')
  const nowPlaying = ref<Track | null>(null)
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
      created.on('trackchange', ({ track, position: at }) => {
        nowPlaying.value = track
        position.value = at
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
   */
  async function startOrder(
    base: PlayOrder,
    at: number,
    scope: SessionRowReader,
    track?: Track
  ): Promise<void> {
    baseOrder = base
    sessionScope = scope

    // The chosen row is pinned to the front of the shuffle, so "shuffle is on"
    // never means "the row I clicked is not what plays". The pin resolves
    // without the permutation, so this costs the click path nothing — the
    // length query and the shuffle itself happen while the track is decoding.
    shuffledOrder = shuffleEnabled.value
      ? createShuffledPlayOrder(base, { seed: shuffleSeed(), pinnedBaseIndex: at })
      : null
    order = shuffledOrder ?? base
    const index = shuffledOrder ? 0 : at
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
    if (track) {
      position.value = orderPosition(index)
      nowPlaying.value = track
    }
    // Deliberately not awaited. `startAt` is the click path and the fill is
    // five round trips behind it; making the audio wait on the queue being
    // drawable would trade the thing the user asked for against a list.
    void fillSession(index)
    await startAt(index, track)
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

    await startOrder(
      createListPlayOrder({
        fetchPage: deps.fetchPage,
        sort: params.sort,
        direction: params.direction,
        filters: params.filters
      }),
      params.index,
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
   * Starts a track from a playlist, traversing that playlist's entries.
   *
   * §5 rule 3: this is what sets `playingPlaylistId`, and it is the only thing
   * that does. Viewing a tab does not, which is the whole point of the split.
   */
  async function playFromPlaylist(params: PlayFromPlaylistParams): Promise<void> {
    playingPlaylistId.value = params.playlistId
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
      params.index,
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
   * first — the engine only resolves `fermata://episode/<id>` for files on disk.
   */
  async function playTracks(params: { tracks: readonly Track[]; index: number }): Promise<void> {
    if (params.tracks.length === 0) return
    const index = Math.max(0, Math.min(params.index, params.tracks.length - 1))
    const track = params.tracks[index]
    if (!track) return

    playingPlaylistId.value = null

    const orderTracks = [...params.tracks]
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
    sessionScope = null
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
    stopCrossfadeWatch()
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
    orderTotal.value = null
    status.value = 'idle'
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
    currentTime,
    duration,
    volume,
    crossfadeMs,
    defaultCrossfadeMs,
    normalizationMode,
    nowPlaying,
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
    orderId: (): string | null => order?.id ?? null,
    /**
     * Test seam: the boundary policy the scheduler will actually apply, as
     * opposed to the one the controller believes applies. The card's claim is
     * about what the scheduler reads, so that is what gets asserted.
     */
    schedulerCrossfadeMs: (): number | null => scheduler?.crossfadeMs ?? null
  }
}

export type PlaybackController = ReturnType<typeof createPlaybackController>
