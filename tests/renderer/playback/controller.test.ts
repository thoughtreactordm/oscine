import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaybackController,
  type PlaybackControllerDeps
} from '../../../src/renderer/playback/controller'
import {
  AUDIO_CROSSFADE_MS,
  AUDIO_CROSSFADE_MS_KEY,
  AUDIO_DECODE_TRACK_CAP_MB,
  AUDIO_OUTPUT_DEVICE,
  AUDIO_PREFETCH_DEPTH,
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB,
  MIB
} from '../../../src/shared/settings'
import { TRANSPORT_REPEAT_KEY } from '../../../src/renderer/playback/transportPreferences'
import { settingsStoreFixture, storedValue } from '../settings/fixture'
import { DEFAULT_NORMALIZATION_POLICY } from '../../../src/renderer/audio/normalization'
import {
  DEFAULT_R1_POLICY,
  type R1AdmissionDecision,
  type R1Policy
} from '../../../src/renderer/audio/r1Admission'
// The contract, not the barrel: these tests compile under the node config,
// which has no DOM, and the barrel reaches the Web Audio implementation.
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type NormalizationPolicy,
  type PlaybackStatus,
  type SampleAccurateTime
} from '../../../src/renderer/audio/AudioEngine'
import type {
  GetTracksByIdsQuery,
  ListTrackIdsQuery,
  ListTrackIdsResult,
  ListTracksQuery,
  ListTracksResult,
  Track
} from '../../../src/shared/library'
import type {
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult
} from '../../../src/shared/playlists'

function track(id: number): Track {
  return {
    id,
    rootId: 1,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: id,
    discNo: null,
    year: null,
    durationSec: 120,
    codec: 'flac',
    encodedBytes: 12_000_000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/**
 * An engine that records what it was asked to do.
 *
 * With `manualLoad`, `load` parks until the test releases it — which is the
 * only way to hold a decode open long enough for a second request to overtake
 * it, and therefore the only way to test supersession honestly.
 */
class FakeEngine implements AudioEngine {
  currentTime = 0
  duration = 0
  volume = 1
  normalizationPolicy: NormalizationPolicy = DEFAULT_NORMALIZATION_POLICY
  decodePolicy: R1Policy = DEFAULT_R1_POLICY
  status: PlaybackStatus = 'idle'
  trackId: number | null = null
  transitionPolicy = 'sample-accurate' as const
  admission: R1AdmissionDecision | null = null
  sampleAccurateEndTime: SampleAccurateTime | null = null

  readonly loaded: number[] = []
  readonly seeks: number[] = []
  readonly volumes: number[] = []
  playCount = 0
  pauseCount = 0
  disposed = false

  private readonly listeners = new Map<string, Set<(payload: never) => void>>()
  private readonly gates: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = []

  constructor(private readonly manualLoad = false) {}

  load(trackId: number): Promise<void> {
    this.loaded.push(trackId)
    this.trackId = trackId
    if (!this.manualLoad) return Promise.resolve()
    return new Promise<void>((resolve, reject) => this.gates.push({ resolve, reject }))
  }

  /** Releases the nth parked `load`. */
  settleLoad(index: number, reason?: unknown): void {
    const gate = this.gates[index]
    if (!gate) throw new Error(`No parked load at ${index}`)
    if (reason) gate.reject(reason)
    else gate.resolve()
  }

  async play(): Promise<void> {
    this.playCount++
    this.status = 'playing'
  }

  pause(): void {
    this.pauseCount++
    this.status = 'paused'
  }

  seek(seconds: number): void {
    this.seeks.push(seconds)
  }

  setVolume(gain: number): void {
    this.volumes.push(gain)
    this.volume = gain
  }

  setNormalizationPolicy(policy: NormalizationPolicy): void {
    this.normalizationPolicy = policy
  }

  setDecodePolicy(policy: Partial<R1Policy>): void {
    this.decodePolicy = { ...this.decodePolicy, ...policy }
  }

  scheduleSampleAccurateStart(_at: SampleAccurateTime, _fadeInDurationSec = 0): boolean {
    return false
  }

  scheduleSampleAccurateFadeOut(_at: SampleAccurateTime, _durationSec: number): boolean {
    return false
  }

  adoptScheduledStart(): boolean {
    return false
  }

  cancelScheduledStart(): void {}

  cancelScheduledFade(): void {}

  readWaveform(): boolean {
    return false
  }

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener as (payload: never) => void)
    this.listeners.set(type, set)
    return () => set.delete(listener as (payload: never) => void)
  }

  emit<K extends keyof AudioEngineEventMap>(type: K, payload: AudioEngineEventMap[K]): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      ;(listener as (value: AudioEngineEventMap[K]) => void)(payload)
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0)
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

/**
 * Track ids for playlist entries start well clear of the library fixture's, so
 * a test that reads `nowPlaying` can say which of the two orders resolved the
 * row rather than inferring it from a position that both would answer.
 */
const PLAYLIST_TRACK_BASE = 1000

function harness(
  options: {
    total?: number
    playlistTotal?: number
    manualLoad?: boolean
    createMediaSession?: PlaybackControllerDeps['createMediaSession']
    settings?: PlaybackControllerDeps['settings']
    createShuffleSeed?: PlaybackControllerDeps['createShuffleSeed']
    crossfadeMs?: number
    /** Shrinks the session fill so the past-the-cap behaviour is reachable. */
    sessionCap?: number
    /**
     * Parks the session fill's first read forever.
     *
     * The only honest way to prove the fill is off the click path: if playback
     * waited on it, `playFromList` would simply never resolve.
     */
    stallSessionFill?: boolean
    setOutputDevice?: PlaybackControllerDeps['setOutputDevice']
    onPlayStarted?: PlaybackControllerDeps['onPlayStarted']
  } = {}
) {
  const total = options.total ?? 10
  const playlistTotal = options.playlistTotal ?? 6
  const engines = [
    new FakeEngine(options.manualLoad ?? false),
    new FakeEngine(options.manualLoad ?? false)
  ]
  let engineIndex = 0
  const fetchPage = vi.fn(async (query: ListTracksQuery): Promise<ListTracksResult> => ({
    tracks: Array.from(
      { length: Math.max(0, Math.min(query.limit, total - query.offset)) },
      (_, i) => track(query.offset + i)
    ),
    total
  }))

  /**
   * The session tier's two verbs, over the same fixture `fetchPage` serves: the
   * row at library position `n` is `track(n)`, so its id is `n` too. That is
   * what lets a test say "the session tier holds positions 1..N" by naming
   * track ids.
   */
  const fetchTrackIds = vi.fn(async (query: ListTrackIdsQuery): Promise<ListTrackIdsResult> => {
    if (options.stallSessionFill) return new Promise<ListTrackIdsResult>(() => {})
    return {
      ids: Array.from(
        { length: Math.max(0, Math.min(query.limit, total - query.offset)) },
        (_, i) => query.offset + i
      ),
      total
    }
  })

  const fetchTracksByIds = vi.fn(async (query: GetTracksByIdsQuery): Promise<Track[]> =>
    query.ids.filter((id) => id < total).map(track)
  )

  /** Answers any window over one playlist, whichever playlist is asked for. */
  const fetchPlaylistEntries = vi.fn(
    async (query: ListPlaylistEntriesQuery): Promise<ListPlaylistEntriesResult> => ({
      entries: Array.from(
        { length: Math.max(0, Math.min(query.limit, playlistTotal - query.offset)) },
        (_, i) => ({
          id: query.offset + i + 1,
          track: track(PLAYLIST_TRACK_BASE + query.offset + i)
        })
      ),
      total: playlistTotal
    })
  )

  const controller = createPlaybackController({
    createEngine: () => {
      const engine = engines[engineIndex++]
      if (!engine) throw new Error('Scheduler created more than two engines')
      return engine
    },
    fetchPage,
    fetchPlaylistEntries,
    fetchTrackIds,
    fetchTracksByIds,
    ...(options.createMediaSession ? { createMediaSession: options.createMediaSession } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.setOutputDevice ? { setOutputDevice: options.setOutputDevice } : {}),
    ...(options.onPlayStarted ? { onPlayStarted: options.onPlayStarted } : {}),
    ...(options.crossfadeMs === undefined ? {} : { crossfadeMs: options.crossfadeMs }),
    ...(options.sessionCap === undefined ? {} : { sessionQueueCap: options.sessionCap }),
    // Fixed by default, so a shuffled traversal is something a test can name.
    createShuffleSeed: options.createShuffleSeed ?? ((): number => 1234)
  })
  return {
    controller,
    engine: engines[0],
    engines,
    fetchPage,
    fetchPlaylistEntries,
    fetchTrackIds,
    fetchTracksByIds
  }
}

/** Lets every already-queued microtask run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createPlaybackController', () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  describe('claiming the audio device', () => {
    it('does not build an engine until something is played', () => {
      // Constructing one grabs an audio device, and autoplay policy only
      // reliably resumes it during a user gesture.
      expect(h.controller.hasEngine()).toBe(false)
    })

    it('replays a volume set before the first play', async () => {
      h.controller.setVolume(0.25)
      expect(h.controller.hasEngine()).toBe(false)

      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })

      expect(h.engine.volumes[0]).toBe(0.25)
    })

    it('clamps a volume outside 0..1', () => {
      h.controller.setVolume(4)
      expect(h.controller.volume.value).toBe(1)
      h.controller.setVolume(-1)
      expect(h.controller.volume.value).toBe(0)
      h.controller.setVolume(Number.NaN)
      expect(h.controller.volume.value).toBe(0)
    })

    it('accepts the temporary crossfade input without claiming the audio device', () => {
      h.controller.setCrossfadeMs(2750)
      expect(h.controller.crossfadeMs.value).toBe(2750)
      expect(h.controller.hasEngine()).toBe(false)

      h.controller.setCrossfadeMs(Number.NaN)
      expect(h.controller.crossfadeMs.value).toBe(0)
    })

    /**
     * W8-4's audible claim, as far as a test can carry it.
     *
     * The setting is written the way the settings view writes it — no call into
     * the controller at all — and the scheduler has the new value before the
     * next boundary is planned. A controller that had snapshotted the setting at
     * construction would still be crossfading at zero here, and the operator
     * would have to relaunch to hear the change they just made.
     */
    it('takes a crossfade written elsewhere without a restart', async () => {
      const store = viewStore()
      const bound = harness({ settings: store.settings })
      await bound.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      expect(bound.controller.schedulerCrossfadeMs()).toBe(0)

      await store.settings.set(AUDIO_CROSSFADE_MS_KEY, 2000)
      await settle()

      expect(bound.controller.crossfadeMs.value).toBe(2000)
      expect(bound.controller.schedulerCrossfadeMs()).toBe(2000)
    })

    /** The other direction: the transport's own control is the same value. */
    it('persists a crossfade set from the transport', async () => {
      const store = viewStore()
      const bound = harness({ settings: store.settings })

      bound.controller.setCrossfadeMs(1500)
      await store.settings.flush()

      expect(store.bridge.rows.get(AUDIO_CROSSFADE_MS_KEY)).toBe(1500)
      expect(store.settings.get<number>(AUDIO_CROSSFADE_MS_KEY)).toBe(1500)
    })

    /**
     * W8-9's live half, for the keys that had no UI before it.
     *
     * The claim each of these makes is the same one W8-4 makes about the
     * crossfade: a value changed in the settings view has to reach a transport
     * that is already playing. A controller that read these at construction
     * would pass a test that only checked its own refs and fail the operator.
     */
    describe('the audio settings that land mid-track', () => {
      async function playing(settings: PlaybackControllerDeps['settings']) {
        const bound = harness({ settings })
        await bound.controller.playFromList({
          sort: 'artist',
          direction: 'asc',
          index: 0,
          track: track(0)
        })
        return bound
      }

      it('carries a pre-amp change to the scheduler', async () => {
        const store = viewStore()
        const bound = await playing(store.settings)
        expect(bound.controller.schedulerNormalizationPolicy()?.preampDb).toBe(0)

        await store.settings.set(AUDIO_REPLAY_GAIN_PREAMP_DB.key, 4.5)
        await settle()

        expect(bound.controller.schedulerNormalizationPolicy()).toMatchObject({
          mode: 'track',
          preampDb: 4.5
        })
        expect(bound.engines.every((engine) => engine.normalizationPolicy.preampDb === 4.5)).toBe(
          true
        )
      })

      it('carries an untagged-track fallback change to the scheduler', async () => {
        const store = viewStore()
        const bound = await playing(store.settings)

        await store.settings.set(AUDIO_REPLAY_GAIN_FALLBACK_DB.key, -3)
        await settle()

        expect(bound.controller.schedulerNormalizationPolicy()?.fallbackGainDb).toBe(-3)
      })

      it('carries an R1 budget change to both engine slots', async () => {
        const store = viewStore()
        const bound = await playing(store.settings)

        await store.settings.set(AUDIO_DECODE_TRACK_CAP_MB.key, 128)
        await settle()

        expect(
          bound.engines.every((engine) => engine.decodePolicy.maxTrackDecodedBytes === 128 * MIB)
        ).toBe(true)
      })

      it('carries a decode-ahead change to the scheduler', async () => {
        const store = viewStore()
        const bound = await playing(store.settings)
        expect(bound.controller.schedulerPrefetchDepth()).toBe(1)

        await store.settings.set(AUDIO_PREFETCH_DEPTH.key, 0)
        await settle()

        expect(bound.controller.schedulerPrefetchDepth()).toBe(0)
      })

      it('writes the mode rather than holding one of its own', async () => {
        // `setNormalizationMode` used to assign a ref the settings view could
        // not see. Now the assignment *is* the persistence, as it is for repeat.
        const store = viewStore()
        const bound = harness({ settings: store.settings })

        bound.controller.setNormalizationMode('album')
        await store.settings.flush()

        expect(store.settings.get<string>(AUDIO_REPLAY_GAIN_MODE.key)).toBe('album')
        expect(bound.controller.normalizationMode.value).toBe('album')
      })

      it('points the audio device at the stored setting before anything plays', async () => {
        // Immediate, unlike the others: the device is not a change to react to
        // at startup, it is the state the contexts have to be built into.
        const store = settingsStoreFixture({ stored: { [AUDIO_OUTPUT_DEVICE.key]: 'usb-dac' } })
        const setOutputDevice = vi.fn(async () => {})
        harness({ settings: store.settings, setOutputDevice })
        await settle()

        expect(setOutputDevice).toHaveBeenCalledWith('usb-dac')
      })

      it('carries a device change made while a track is playing', async () => {
        const store = viewStore()
        const setOutputDevice = vi.fn(async () => {})
        const bound = harness({ settings: store.settings, setOutputDevice })
        await bound.controller.playFromList({
          sort: 'artist',
          direction: 'asc',
          index: 0,
          track: track(0)
        })
        setOutputDevice.mockClear()

        await store.settings.set(AUDIO_OUTPUT_DEVICE.key, 'headphones')
        await settle()

        expect(setOutputDevice).toHaveBeenCalledWith('headphones')
      })
    })

    it('defaults to track normalization and replays a pre-play mode choice', async () => {
      expect(h.controller.normalizationMode.value).toBe('track')
      h.controller.setNormalizationMode('album')
      expect(h.controller.hasEngine()).toBe(false)

      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })

      expect(h.engines.every((engine) => engine.normalizationPolicy.mode === 'album')).toBe(true)
    })
  })

  describe('starting a track from the list', () => {
    it('loads and plays the clicked row without looking it up again', async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 4,
        track: track(4)
      })

      expect(h.engine.loaded).toEqual([4])
      expect(h.engine.playCount).toBe(1)
      expect(h.controller.orderIndex.value).toBe(4)
      expect(h.controller.nowPlaying.value?.id).toBe(4)
      // The row was handed over, so the only lookup is the decode-ahead row.
      expect(h.fetchPage).toHaveBeenCalledTimes(1)
      expect(h.fetchPage).toHaveBeenCalledWith({
        sort: 'artist',
        direction: 'asc',
        offset: 5,
        limit: 1
      })
    })

    it('captures the list ordering as the play order', async () => {
      await h.controller.playFromList({
        sort: 'album',
        direction: 'desc',
        index: 0,
        track: track(0)
      })
      expect(h.controller.orderId()).toBe('list:album:desc')
    })
  })

  describe('next and previous', () => {
    beforeEach(async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 2,
        track: track(2)
      })
    })

    it('advances to the following row in the captured order', async () => {
      await h.controller.next()

      expect(h.controller.orderIndex.value).toBe(3)
      expect(h.controller.nowPlaying.value?.id).toBe(3)
      expect(h.engines[0].loaded).toEqual([2, 4])
      expect(h.engines[1].loaded).toEqual([3])
    })

    it('steps back to the preceding row', async () => {
      await h.controller.previous()

      expect(h.controller.orderIndex.value).toBe(1)
      expect(h.engines[0].loaded).toEqual([2])
      expect(h.engines[1].loaded).toEqual([3, 1])
    })

    it('keeps traversing the ordering it started with, not whatever is browsed now', async () => {
      // Design §5: browsing must not disturb playback. Re-sorting the list is a
      // change to what is viewed; the play order was snapshotted at play time.
      await h.controller.next()

      expect(h.fetchPage).toHaveBeenCalledWith({
        sort: 'artist',
        direction: 'asc',
        offset: 3,
        limit: 1
      })
    })

    it('does nothing before the first row', async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      const loads = h.engine.loaded.length

      await h.controller.previous()

      expect(h.controller.orderIndex.value).toBe(0)
      expect(h.engine.loaded).toHaveLength(loads)
    })

    it('does nothing when nothing is playing', async () => {
      const fresh = harness()
      await fresh.controller.next()
      await fresh.controller.previous()

      expect(fresh.controller.hasEngine()).toBe(false)
    })
  })

  describe('repeat', () => {
    async function playing(total: number, index: number) {
      const h = harness({ total })
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index,
        track: track(index)
      })
      return h
    }

    it('costs no length query while it is off', async () => {
      // The play path deliberately avoids a lookup when the clicked row is
      // already in hand; a length nothing can use would put one back.
      const h = await playing(3, 0)
      expect(h.fetchPage).toHaveBeenCalledTimes(1)
      expect(h.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 1 }))
    })

    it('wraps to the top from the last row', async () => {
      const h = await playing(3, 2)
      h.controller.setRepeatMode('all')
      await settle()

      await h.controller.next()

      expect(h.controller.orderIndex.value).toBe(0)
      expect(h.controller.nowPlaying.value?.id).toBe(0)
    })

    it('wraps to the last row from the top', async () => {
      const h = await playing(3, 0)
      h.controller.setRepeatMode('all')
      await settle()

      await h.controller.previous()

      expect(h.controller.orderIndex.value).toBe(2)
      expect(h.controller.nowPlaying.value?.id).toBe(2)
    })

    it('still stops at the last row once repeat is switched back off', async () => {
      const h = await playing(3, 2)
      h.controller.setRepeatMode('all')
      await settle()
      h.controller.setRepeatMode('off')
      await settle()

      await h.controller.next()

      expect(h.controller.orderIndex.value).toBe(2)
      expect(h.controller.error.value).toBeNull()
    })

    it('moves on when Next is pressed under repeat-one', async () => {
      const h = await playing(6, 2)
      h.controller.setRepeatMode('one')
      await settle()

      await h.controller.next()

      expect(h.controller.orderIndex.value).toBe(3)
    })

    it('cycles none, all, one and back on one button', () => {
      const h = harness()
      expect(h.controller.repeatMode.value).toBe('off')
      h.controller.cycleRepeat()
      expect(h.controller.repeatMode.value).toBe('all')
      h.controller.cycleRepeat()
      expect(h.controller.repeatMode.value).toBe('one')
      h.controller.cycleRepeat()
      expect(h.controller.repeatMode.value).toBe('off')
    })

    it('is a setting, so stopping does not clear it', async () => {
      const h = await playing(3, 1)
      h.controller.setRepeatMode('one')

      h.controller.stop()

      expect(h.controller.repeatMode.value).toBe('one')
    })
  })

  describe('shuffle', () => {
    /** A traversal is only shuffled if it is not the order it permutes. */
    async function traverse(controller: ReturnType<typeof harness>['controller'], steps: number) {
      const seen = [controller.nowPlaying.value?.id]
      for (let i = 0; i < steps; i += 1) {
        await controller.next()
        seen.push(controller.nowPlaying.value?.id)
      }
      return seen
    }

    it('plays the row that was clicked, then shuffles what follows', async () => {
      // "Shuffle is on" must never mean "the row I clicked is not what plays".
      const h = harness({ total: 40 })
      await h.controller.setShuffle(true)

      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 12,
        track: track(12)
      })
      await settle()

      expect(h.controller.nowPlaying.value?.id).toBe(12)
      expect(h.controller.orderIndex.value).toBe(0)
      expect(h.controller.orderId()).toBe('shuffle:1234:12:list:artist:asc')
      expect(await traverse(h.controller, 5)).not.toEqual([12, 13, 14, 15, 16, 17])
    })

    it('does not interrupt what is playing when switched on', async () => {
      const h = harness({ total: 40 })
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 12,
        track: track(12)
      })
      const loaded = [...h.engines[0].loaded]

      await h.controller.setShuffle(true)
      await settle()

      expect(h.controller.nowPlaying.value?.id).toBe(12)
      expect(h.controller.orderIndex.value).toBe(0)
      // Neither decoded again nor started again: only the successor changed.
      expect(h.engines[0].loaded).toEqual(loaded)
      expect(h.engines[0].playCount).toBe(1)
      expect(h.engines[0].pauseCount).toBe(0)
    })

    it('resumes linear traversal from where the user actually is', async () => {
      // Not from where the shuffle started: anything else reads as the
      // transport jumping when the button is pressed.
      const h = harness({ total: 40 })
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 12,
        track: track(12)
      })
      await h.controller.setShuffle(true)
      await h.controller.next()
      await h.controller.next()
      const landedOn = h.controller.nowPlaying.value?.id

      await h.controller.setShuffle(false)
      await settle()

      expect(h.controller.orderId()).toBe('list:artist:asc')
      // Track ids are their own base positions in this library, so the two
      // agreeing is the round trip through the permutation coming back.
      expect(h.controller.orderIndex.value).toBe(landedOn)
      expect(h.controller.nowPlaying.value?.id).toBe(landedOn)

      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe((landedOn ?? 0) + 1)
    })

    it('reshuffles rather than resuming the old sequence', async () => {
      let seed = 0
      const h = harness({ total: 40, createShuffleSeed: () => ++seed })
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })

      await h.controller.setShuffle(true)
      const first = await traverse(h.controller, 5)
      await h.controller.setShuffle(false)
      await h.controller.setShuffle(true)
      const second = await traverse(h.controller, 5)

      expect(second).not.toEqual(first)
    })

    it('only records the preference when nothing is playing', async () => {
      const h = harness()

      await h.controller.toggleShuffle()

      expect(h.controller.shuffleEnabled.value).toBe(true)
      expect(h.controller.hasEngine()).toBe(false)
      expect(h.controller.orderId()).toBeNull()
    })

    it('is a setting, so stopping does not clear it', async () => {
      const h = harness({ total: 40 })
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      await h.controller.setShuffle(true)

      h.controller.stop()

      expect(h.controller.shuffleEnabled.value).toBe(true)
      expect(h.controller.orderId()).toBeNull()
    })
  })

  /**
   * The real settings surface over a memory area and a faked main.
   *
   * Both scopes, because the controller now reads both: shuffle and repeat are
   * view keys, and the global crossfade is a durable one.
   */
  function viewStore() {
    return settingsStoreFixture()
  }

  describe('remembering the modes', () => {
    it('restores shuffle and repeat from a previous session', async () => {
      const store = viewStore()
      const before = harness({ settings: store.settings })
      before.controller.setRepeatMode('one')
      await before.controller.setShuffle(true)

      const after = harness({ settings: store.settings })

      expect(after.controller.repeatMode.value).toBe('one')
      expect(after.controller.shuffleEnabled.value).toBe(true)
    })

    it('runs unbound', () => {
      // Omitting the view store is a supported configuration: the modes last
      // for the session, which is what every other test here wants.
      const h = harness()
      expect(() => h.controller.setRepeatMode('all')).not.toThrow()
      expect(h.controller.repeatMode.value).toBe('all')
    })
  })

  describe('the end of the order', () => {
    it('stops cleanly past the last row instead of erroring', async () => {
      const end = harness({ total: 3 })
      await end.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 2,
        track: track(2)
      })

      await expect(end.controller.next()).resolves.toBeUndefined()

      expect(end.engine.pauseCount).toBe(1)
      expect(end.engine.loaded).toEqual([2])
      expect(end.controller.error.value).toBeNull()
      // Left on the last real row, so Previous still has somewhere to go.
      expect(end.controller.orderIndex.value).toBe(2)
    })

    it('reports a failed lookup without moving', async () => {
      const broken = harness()
      await broken.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 1,
        track: track(1)
      })
      await settle()
      // The successor has to come from the *order* for a lookup to be able to
      // fail at all: with the session tier standing, rule 1 answers from the
      // queue and never asks. Draining it puts the order back in the path.
      broken.controller.clearQueue()
      await settle()
      broken.fetchPage.mockRejectedValue(new Error('ipc down'))

      await broken.controller.next()

      expect(broken.controller.orderIndex.value).toBe(1)
      expect(broken.controller.error.value).toBe('Could not read the next track.')
    })
  })

  describe('rapid skipping', () => {
    it('advances once per press rather than racing to the same row', async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })

      void h.controller.next()
      void h.controller.next()
      await settle()

      expect(h.controller.orderIndex.value).toBe(2)
      expect(h.controller.nowPlaying.value?.id).toBe(2)
    })

    it('never starts a track the user has already skipped past', async () => {
      // The acceptance criterion: no orphaned audio from a previous track
      // continuing underneath. The superseded request must not reach `play`.
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      const playsBefore = h.engine.playCount

      void h.controller.next()
      void h.controller.next()
      await settle()

      expect(h.engines.flatMap((engine) => engine.loaded)).toContain(2)
      expect(h.engines.reduce((sum, engine) => sum + engine.playCount, 0)).toBe(playsBefore + 1)
    })

    it('abandons a slow decode that a newer request overtook', async () => {
      const slow = harness({ manualLoad: true })
      void slow.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      void slow.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 5,
        track: track(5)
      })
      await settle()

      // The first decode finishes late — after it has already been superseded.
      slow.engines[1].settleLoad(0)
      await settle()
      slow.engines[0].settleLoad(0)
      await settle()

      expect(slow.engines.reduce((sum, engine) => sum + engine.playCount, 0)).toBe(1)
      expect(slow.controller.nowPlaying.value?.id).toBe(5)
    })
  })

  describe('mirroring the engine', () => {
    beforeEach(async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
    })

    it('follows time and duration from the engine', () => {
      h.engine.emit('timeupdate', { currentTime: 12.5, duration: 200 })

      expect(h.controller.currentTime.value).toBe(12.5)
      expect(h.controller.duration.value).toBe(200)
      expect(h.controller.canSeek.value).toBe(true)
    })

    it('follows status transitions', () => {
      h.engine.emit('statuschange', 'playing')
      expect(h.controller.isPlaying.value).toBe(true)

      h.engine.emit('statuschange', 'loading')
      expect(h.controller.isLoading.value).toBe(true)
      expect(h.controller.isPlaying.value).toBe(false)
    })

    it('surfaces an engine error', () => {
      h.engine.emit('error', new AudioEngineError('decode-failed', 'Not decodable.', 1))
      expect(h.controller.error.value).toBe('Not decodable.')
    })

    it('does not report a superseded load as a fault', async () => {
      const aborted = harness({ manualLoad: true })
      void aborted.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      await settle()

      aborted.engine.settleLoad(0, new AudioEngineError('aborted', 'Superseded.', 0))
      await settle()

      expect(aborted.controller.error.value).toBeNull()
    })

    it('promotes the prefetched track when the current engine ends', async () => {
      h.engine.emit('ended', { trackId: 0 })
      await settle()

      expect(h.engines[1].loaded).toEqual([1])
      expect(h.controller.orderIndex.value).toBe(1)
      expect(h.controller.nowPlaying.value?.id).toBe(1)
    })
  })

  describe('seeking', () => {
    beforeEach(async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      h.engine.emit('timeupdate', { currentTime: 0, duration: 100 })
    })

    it('holds the handle against engine updates while it is dragged', () => {
      h.controller.beginScrub()
      h.controller.scrubTo(60)

      h.engine.emit('timeupdate', { currentTime: 3, duration: 100 })

      expect(h.controller.currentTime.value).toBe(60)
      // Nothing is committed mid-drag; the audio does not jump under the pointer.
      expect(h.engine.seeks).toEqual([])
    })

    it('commits on release and resumes following', () => {
      h.controller.beginScrub()
      h.controller.scrubTo(60)
      h.controller.endScrub()

      expect(h.engine.seeks).toEqual([60])

      h.engine.emit('timeupdate', { currentTime: 61, duration: 100 })
      expect(h.controller.currentTime.value).toBe(61)
    })

    it('ignores a release that follows no grab', () => {
      // A range input fires both `pointerup` and `change`, and keyboard seeking
      // fires neither a grab nor a pointer release.
      h.controller.endScrub()
      h.controller.endScrub()

      expect(h.engine.seeks).toEqual([])
    })

    it('commits an undragged seek immediately', () => {
      h.controller.seek(42)

      expect(h.engine.seeks).toEqual([42])
      expect(h.controller.currentTime.value).toBe(42)
    })

    it('clamps a seek to the track', () => {
      h.controller.seek(500)
      expect(h.controller.currentTime.value).toBe(100)

      h.controller.seek(-5)
      expect(h.controller.currentTime.value).toBe(0)
    })
  })

  describe('toggle', () => {
    it('does nothing with no track, and claims no device', async () => {
      await h.controller.toggle()
      expect(h.controller.hasEngine()).toBe(false)
    })

    it('pauses what is playing and resumes what is not', async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      h.engine.emit('statuschange', 'playing')

      await h.controller.toggle()
      expect(h.engine.pauseCount).toBe(1)

      h.engine.emit('statuschange', 'paused')
      await h.controller.toggle()
      expect(h.engine.playCount).toBe(2)
    })
  })

  describe('dispose', () => {
    it('releases the device and every subscription', async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })

      h.controller.dispose()

      expect(h.engine.disposed).toBe(true)
      expect(h.engine.listenerCount()).toBe(0)
      expect(h.controller.hasEngine()).toBe(false)
      expect(h.controller.status.value).toBe('idle')
    })

    it('is safe to call twice', () => {
      expect(() => {
        h.controller.dispose()
        h.controller.dispose()
      }).not.toThrow()
    })

    it('strands a request that was still in flight', async () => {
      const slow = harness({ manualLoad: true })
      void slow.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      await settle()

      slow.controller.dispose()
      slow.engine.settleLoad(0)
      await settle()

      // A disposed engine is unusable; the late decode must not try to play it.
      expect(slow.engine.playCount).toBe(0)
    })
  })

  describe('resume and pause as intents', () => {
    // The OS media session needs idempotent intents rather than a flip: with a
    // track on the R1 streaming fallback its real media element is a session
    // participant alongside the silent anchor, so one OS press can reach the
    // controller twice. See `mediaSession.ts`.
    beforeEach(async () => {
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      h.engine.emit('statuschange', 'playing')
    })

    it('pauses once when asked twice', () => {
      h.controller.pause()
      h.engine.emit('statuschange', 'paused')
      h.controller.pause()
      expect(h.engine.pauseCount).toBe(1)
    })

    it('does not resume a track that is already playing', async () => {
      const before = h.engine.playCount
      await h.controller.resume()
      expect(h.engine.playCount).toBe(before)
    })

    it('still flips when the transport button is used', async () => {
      h.controller.pause()
      h.engine.emit('statuschange', 'paused')
      await h.controller.toggle()
      expect(h.engine.playCount).toBe(2)
    })
  })

  describe('OS media session', () => {
    it('runs unbound where the runtime has no media session', () => {
      expect(h.controller.mediaSession()).toBeNull()
    })

    it('binds the transport intents and releases the binding with the controller', () => {
      const seen: Array<{ state: unknown; transport: unknown }> = []
      const dispose = vi.fn()
      const bound = harness({
        createMediaSession: (deps) => {
          seen.push(deps)
          return { dispose, hasAnchor: () => false }
        }
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]!.transport).toMatchObject({
        resume: expect.any(Function),
        pause: expect.any(Function),
        stop: expect.any(Function),
        next: expect.any(Function),
        previous: expect.any(Function),
        seek: expect.any(Function)
      })
      expect(bound.controller.mediaSession()).not.toBeNull()

      bound.controller.dispose()
      expect(dispose).toHaveBeenCalledTimes(1)
    })
  })

  describe('playing a playlist', () => {
    it('traverses the playlist it was handed rather than the library', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 1 })

      expect(h.controller.orderId()).toBe('playlist:7')
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 1)
      expect(h.fetchPlaylistEntries).toHaveBeenCalledWith({ playlistId: 7, offset: 1, limit: 1 })
      // The library is not consulted at all, not even to size anything.
      expect(h.fetchPage).not.toHaveBeenCalled()
    })

    it('plays a row it was handed without looking it up again', async () => {
      const h = harness()
      await h.controller.playFromPlaylist({
        playlistId: 7,
        index: 3,
        track: track(PLAYLIST_TRACK_BASE + 3)
      })

      expect(h.engine.loaded).toEqual([PLAYLIST_TRACK_BASE + 3])
      expect(h.controller.orderIndex.value).toBe(3)
      // As with the list: the row was handed over, so nothing looked it up.
      // Stated as "not this window" rather than as a call count, because the
      // session fill reads the same playlist for its own reasons and is not
      // the lookup this is about.
      expect(h.fetchPlaylistEntries).not.toHaveBeenCalledWith({
        playlistId: 7,
        offset: 3,
        limit: 1
      })
      expect(h.fetchPlaylistEntries).toHaveBeenCalledWith({ playlistId: 7, offset: 4, limit: 1 })
    })

    it('advances through the playlist entries', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      await h.controller.next()

      expect(h.controller.orderIndex.value).toBe(1)
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 1)
    })

    // §5 rule 3. Nothing else in the controller writes it, and viewing a tab
    // is emphatically not "playing a track from a playlist".
    it('records which playlist is playing, and clears it for the library', async () => {
      const h = harness()
      expect(h.controller.playingPlaylistId.value).toBeNull()

      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      expect(h.controller.playingPlaylistId.value).toBe(7)

      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      expect(h.controller.playingPlaylistId.value).toBeNull()
      expect(h.controller.orderId()).toBe('list:artist:asc')
    })

    it('stops cleanly at the playlist end rather than running into the library', async () => {
      const h = harness({ total: 50, playlistTotal: 3 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
      await h.controller.next()

      // Position 3 exists in the library fixture and not in the playlist, so a
      // traversal that had leaked into the library would have advanced here.
      expect(h.controller.orderIndex.value).toBe(2)
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 2)
    })

    it('wraps at the playlist end under repeat-all, not the library end', async () => {
      const h = harness({ total: 50, playlistTotal: 3 })
      h.controller.setRepeatMode('all')
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
      await settle()

      expect(h.controller.orderTotal.value).toBe(3)

      await h.controller.next()
      expect(h.controller.orderIndex.value).toBe(0)
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE)
    })

    describe('shuffle', () => {
      it('permutes the playing playlist entries and nothing else', async () => {
        const h = harness({ total: 50, playlistTotal: 5 })
        await h.controller.setShuffle(true)
        await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
        await settle()

        // The shuffle is layered over the playlist order, which is the whole of
        // "a playlist gets shuffle for free": the id names both.
        expect(h.controller.orderId()).toBe('shuffle:1234:2:playlist:7')
        // The pinned row is the one that was clicked, at its new position 0.
        expect(h.controller.orderIndex.value).toBe(0)
        expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 2)

        const played: number[] = []
        for (let step = 0; step < 4; step += 1) {
          await h.controller.next()
          played.push(h.controller.nowPlaying.value!.id)
        }

        // Every row came from the playlist, and each of its entries appeared
        // exactly once — a permutation of that playlist, not a walk into the
        // fifty-row library beside it.
        const visited = [PLAYLIST_TRACK_BASE + 2, ...played].sort((a, b) => a - b)
        expect(visited).toEqual([0, 1, 2, 3, 4].map((i) => PLAYLIST_TRACK_BASE + i))
        expect(h.fetchPage).not.toHaveBeenCalled()
      })

      it('keeps the unshuffled playlist order alongside the shuffled one', async () => {
        const h = harness({ playlistTotal: 5 })
        await h.controller.setShuffle(true)
        await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
        await settle()

        await h.controller.setShuffle(false)

        // Exactly as for the library order: switching shuffle off resumes the
        // linear traversal from where the user actually is, and the base order
        // that survived is the playlist's own.
        expect(h.controller.orderId()).toBe('playlist:7')
        expect(h.controller.orderIndex.value).toBe(2)
        expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 2)
      })
    })

    describe('the viewed and playing split', () => {
      /**
       * The §5 preamble's guarantee, tested from the playback side.
       *
       * `viewedPlaylistId` lives in the playlists store and cannot be reached
       * from here — that is the point, and it is also why this test does not
       * instantiate the store. Stores compile against `@renderer` and the DOM,
       * neither of which exists under this config, so what is exercised instead
       * is the only thing viewing a tab actually does to the outside world:
       * page another playlist's entries through the same dependency the playing
       * traversal uses.
       */
      it('leaves playback untouched while another playlist is browsed', async () => {
        const h = harness({ playlistTotal: 6 })
        await h.controller.playFromPlaylist({ playlistId: 7, index: 1 })
        await settle()

        const before = {
          orderId: h.controller.orderId(),
          orderIndex: h.controller.orderIndex.value,
          trackId: h.controller.nowPlaying.value?.id,
          playingPlaylistId: h.controller.playingPlaylistId.value,
          loaded: [...h.engine.loaded],
          playCount: h.engine.playCount,
          pauseCount: h.engine.pauseCount,
          disposed: h.engine.disposed,
          prefetchStatus: h.controller.prefetchStatus.value,
          prefetchedTrackId: h.controller.prefetchedTrackId.value
        }

        // What the contents pane does when the user clicks a different tab.
        await h.fetchPlaylistEntries({ playlistId: 9, offset: 0, limit: 100 })
        await h.fetchPlaylistEntries({ playlistId: 9, offset: 100, limit: 100 })
        await settle()

        expect({
          orderId: h.controller.orderId(),
          orderIndex: h.controller.orderIndex.value,
          trackId: h.controller.nowPlaying.value?.id,
          playingPlaylistId: h.controller.playingPlaylistId.value,
          loaded: [...h.engine.loaded],
          playCount: h.engine.playCount,
          pauseCount: h.engine.pauseCount,
          disposed: h.engine.disposed,
          prefetchStatus: h.controller.prefetchStatus.value,
          prefetchedTrackId: h.controller.prefetchedTrackId.value
        }).toEqual(before)
      })

      it('offers no way to set a viewed playlist', () => {
        // Structural, and deliberately so: the guarantee above is worth more as
        // "there is no wire to pull" than as a rule someone has to remember.
        expect(harness().controller).not.toHaveProperty('viewedPlaylistId')
      })
    })

    // §5 rule 4, second half.
    describe('deletion', () => {
      it('stops playback when the playing playlist is deleted', async () => {
        const h = harness()
        await h.controller.playFromPlaylist({ playlistId: 7, index: 1 })
        expect(h.engine.playCount).toBe(1)

        h.controller.playlistDeleted(7)

        // A real stop, not merely forgotten state: the device is released, so
        // nothing can still be audible from a playlist that no longer exists.
        expect(h.engine.disposed).toBe(true)
        expect(h.controller.status.value).toBe('idle')
        expect(h.controller.orderId()).toBeNull()
        expect(h.controller.nowPlaying.value).toBeNull()
        expect(h.controller.playingPlaylistId.value).toBeNull()
      })

      it('leaves playback alone when any other playlist is deleted', async () => {
        const h = harness()
        await h.controller.playFromPlaylist({ playlistId: 7, index: 1 })

        h.controller.playlistDeleted(9)

        expect(h.engine.disposed).toBe(false)
        expect(h.controller.orderId()).toBe('playlist:7')
        expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 1)
        expect(h.controller.playingPlaylistId.value).toBe(7)
      })

      it('leaves a library traversal alone', async () => {
        const h = harness()
        await h.controller.playFromList({
          sort: 'artist',
          direction: 'asc',
          index: 0,
          track: track(0)
        })

        h.controller.playlistDeleted(7)

        expect(h.engine.disposed).toBe(false)
        expect(h.controller.orderId()).toBe('list:artist:asc')
      })
    })

    /**
     * R2's boundary policy, now resolved through W8-5's cascade rather than
     * handed in at play time.
     *
     * The controller holds no crossfade of its own for a playlist: it holds a
     * playlist *id*, and `audio.crossfadeMs` resolved at that id is the answer.
     * Everything below is a consequence of that one change of shape, which is
     * why "an edit while it is playing reaches the scheduler" no longer needs a
     * method to tell the controller about it.
     */
    describe('the boundary policy', () => {
      /** A settings surface with the playlist already overriding the global. */
      async function overriding(globalMs: number, playlistMs: number) {
        const store = settingsStoreFixture({ stored: { [AUDIO_CROSSFADE_MS_KEY]: globalMs } })
        store.bridge.seedOverride({ kind: 'playlist', id: 7 }, AUDIO_CROSSFADE_MS_KEY, playlistMs)
        await store.settings.ready
        return store
      }

      it('gives the scheduler the playing playlist’s override', async () => {
        const store = await overriding(250, 1500)
        const h = harness({ settings: store.settings })

        await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
        await settle()

        expect(h.controller.crossfadeMs.value).toBe(1500)
        expect(h.controller.schedulerCrossfadeMs()).toBe(1500)
      })

      it('inherits the global for a playlist with no override', async () => {
        const store = await overriding(250, 1500)
        const h = harness({ settings: store.settings })

        // Playlist 9 has no row of its own, so it plays the way the library does.
        await h.controller.playFromPlaylist({ playlistId: 9, index: 0 })
        await settle()

        expect(h.controller.schedulerCrossfadeMs()).toBe(250)
      })

      it('gives the global setting back when the library plays again', async () => {
        const store = await overriding(250, 1500)
        const h = harness({ settings: store.settings })

        await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
        await settle()
        await h.controller.playFromList({
          sort: 'artist',
          direction: 'asc',
          index: 0,
          track: track(0)
        })

        expect(h.controller.schedulerCrossfadeMs()).toBe(250)
      })

      it('keeps the override while the global setting is changed under it', async () => {
        const store = await overriding(250, 1500)
        const h = harness({ settings: store.settings })

        await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
        await settle()
        h.controller.setCrossfadeMs(800)
        await settle()

        expect(h.controller.defaultCrossfadeMs.value).toBe(800)
        expect(h.controller.schedulerCrossfadeMs()).toBe(1500)
      })

      /**
       * The rule the retired `playlistCrossfadeChanged` existed to enforce, now
       * a consequence of reading the cascade rather than a snapshot of it.
       */
      it('follows an edit to the playing playlist, and ignores one to another', async () => {
        const store = await overriding(250, 1500)
        const h = harness({ settings: store.settings })

        await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
        await settle()

        await store.settings.setOverride(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: 9 }, 4000)
        await settle()
        expect(h.controller.schedulerCrossfadeMs()).toBe(1500)

        await store.settings.setOverride(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: 7 }, 0)
        await settle()
        expect(h.controller.schedulerCrossfadeMs()).toBe(0)
      })

      /** Reverting the override is what gives a playlist the library's answer. */
      it('falls back to the global when the override is reverted mid-playback', async () => {
        const store = await overriding(250, 1500)
        const h = harness({ settings: store.settings })

        await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
        await settle()
        expect(h.controller.schedulerCrossfadeMs()).toBe(1500)

        await store.settings.clearOverride(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: 7 })
        await settle()

        expect(h.controller.schedulerCrossfadeMs()).toBe(250)
      })
    })
  })
  /**
   * The same seven numbers as `upNextQueue.test.ts`, carried through the
   * transport.
   *
   * The rules are *proved* against the headless model; these are the checks
   * that the wiring actually consults it — that decode-ahead warms the queue
   * head rather than the playing playlist's next entry, and that nothing in the
   * controller quietly clears a queue the rules say survives.
   */
  describe('the up-next queue (§5)', () => {
    type Controller = ReturnType<typeof harness>['controller']

    const queuedIds = (controller: Controller): number[] =>
      controller.queuedEntries.value.map((entry) => entry.trackId)

    /**
     * The tiers, separately — which is what most of the seven rules are about
     * since the 2026-07-31 amendment. Rules 2, 3 and 6 all narrowed to the
     * *user* tier, because the session tier is filled by starting playback
     * rather than by queueing, and is replaced by it rather than surviving it.
     */
    const userIds = (controller: Controller): number[] =>
      controller.queuedUserEntries.value.map((entry) => entry.trackId)

    const sessionIds = (controller: Controller): number[] =>
      controller.queuedSessionEntries.value.map((entry) => entry.trackId)

    it('rule 1: decode-ahead warms the queue head, not the playing playlist next entry', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      await settle()
      // Nothing hand-queued yet. The successor is the playlist's second entry
      // either way — since the amendment it arrives as the session tier's head
      // rather than as a bare order row, which is a change of identity and not
      // of which track gets warmed.
      expect(h.controller.prefetchedTrackId.value).toBe(PLAYLIST_TRACK_BASE + 1)

      h.controller.enqueue([track(42)])
      await settle()

      // The boundary that was already armed is re-decided rather than left
      // pointing at the row the queue has just displaced. Warming the wrong
      // track is not merely a wrong answer — it spends R1's budget to get it.
      expect(h.engines[1].loaded.at(-1)).toBe(42)
      expect(h.controller.prefetchedTrackId.value).toBe(42)
      expect(h.controller.prefetchStatus.value).toBe('ready')
    })

    it('rule 1: an add behind a queued row leaves the armed boundary alone', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42)])
      await settle()
      expect(h.engines[1].loaded).toEqual([PLAYLIST_TRACK_BASE + 1, 42])

      h.controller.enqueue([track(43)])
      await settle()

      // The head did not move, so the decode that is ready stays ready.
      // Discarding it would turn an "add to queue" into an audible risk.
      expect(h.engines[1].loaded).toEqual([PLAYLIST_TRACK_BASE + 1, 42])
      expect(h.controller.prefetchedTrackId.value).toBe(42)
    })

    it('rule 1: the queue head plays next, is shifted out, and traversal resumes after the row it interrupted', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42)])
      await settle()

      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(42)
      expect(h.controller.queuedUserCount.value).toBe(0)
      // §5 rule 2's other half: the *user* detour did not move the position.
      expect(h.controller.orderIndex.value).toBe(0)
      expect(h.controller.playingQueueEntryId.value).not.toBeNull()

      await h.controller.next()
      // Entry 1, not entry 2: a user entry is a detour, and traversal resumes
      // after the row it was taken from rather than after itself. Since the
      // amendment that row reaches the transport as the session tier's head,
      // so the position it names is the same and its identity is not.
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 1)
      expect(h.controller.orderIndex.value).toBe(1)
      expect(sessionIds(h.controller)).toEqual([PLAYLIST_TRACK_BASE + 2, PLAYLIST_TRACK_BASE + 3])
    })

    it('rule 1: two fast presses take two entries rather than the same one twice', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42), track(43)])
      await settle()

      // The shift is synchronous for exactly this: the decode the second press
      // adopts is chosen inside an await the first press has not left yet.
      await Promise.all([h.controller.next(), h.controller.next()])

      expect(h.controller.queuedUserCount.value).toBe(0)
      expect(h.controller.nowPlaying.value?.id).toBe(43)
    })

    it('rule 1: the shift also happens when a boundary promotes the queued track', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42)])
      await settle()

      // The one advance the controller is not party to.
      h.engine.emit('ended', { trackId: PLAYLIST_TRACK_BASE })
      await settle()

      expect(h.controller.nowPlaying.value?.id).toBe(42)
      expect(h.controller.queuedUserCount.value).toBe(0)
      expect(h.controller.orderIndex.value).toBe(0)
    })

    it('rule 1: Previous backs out of a queue detour to the row it interrupted', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
      h.controller.enqueue([track(42)])
      await settle()
      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(42)

      await h.controller.previous()

      // Entry 2, not entry 1. The queued row has already been shifted out, so
      // the interrupted row is the only thing Previous could mean.
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 2)
      expect(h.controller.orderIndex.value).toBe(2)
      expect(h.controller.playingQueueEntryId.value).toBeNull()
    })

    it('rule 2: queueing changes neither playingPlaylistId nor the current position', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
      await settle()
      const playing = h.controller.nowPlaying.value

      h.controller.enqueue([track(42)])
      h.controller.enqueueNext([track(43)])
      h.controller.moveQueued(h.controller.queuedEntries.value[0]?.id ?? '', 1)
      h.controller.removeQueued(h.controller.queuedEntries.value[0]?.id ?? '')
      await settle()

      expect(h.controller.playingPlaylistId.value).toBe(7)
      expect(h.controller.orderIndex.value).toBe(2)
      expect(h.controller.nowPlaying.value).toBe(playing)
      // Nor did any of it reach the audio graph: no re-decode, no new engine.
      expect(h.engine.loaded).toEqual([PLAYLIST_TRACK_BASE + 2])
    })

    it('rule 3: playing a track from another playlist leaves the queue standing', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42), track(43)])
      await settle()

      await h.controller.playFromPlaylist({ playlistId: 9, index: 1 })
      expect(h.controller.playingPlaylistId.value).toBe(9)
      // The *user* tier, which is what rule 3 narrowed to in the amendment.
      // The session tier is replaced by a new session rather than surviving it.
      expect(userIds(h.controller)).toEqual([42, 43])

      // Nor does going back to the library, nor stopping outright.
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      expect(userIds(h.controller)).toEqual([42, 43])
      h.controller.stop()
      await settle()
      // Stopping ends a traversal, so the session tier ends with it — and the
      // hand-queued rows are all that is left, which is the whole queue again.
      expect(queuedIds(h.controller)).toEqual([42, 43])
    })

    it('rule 4: deleting the playlist a queued track came from leaves the queue intact', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      // Queued from playlist 9, which is about to be deleted. The queue holds
      // track ids, so there is nothing on these rows for the deletion to reach.
      h.controller.enqueue([track(42), track(43)])
      await settle()

      h.controller.playlistDeleted(9)
      expect(userIds(h.controller)).toEqual([42, 43])
      // A deletion of any other playlist is not playback's business.
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE)

      // And the second half: deleting the *playing* playlist stops playback —
      // which still does not touch the queue.
      h.controller.playlistDeleted(7)
      expect(h.controller.nowPlaying.value).toBeNull()
      expect(queuedIds(h.controller)).toEqual([42, 43])
    })

    it('rule 5: the queue is transient — nothing about it is persisted', async () => {
      const store = viewStore()
      const before = harness({ settings: store.settings })
      await before.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      before.controller.enqueue([track(42), track(43)])
      before.controller.setRepeatMode('all')
      await settle()
      expect(before.controller.queuedUserCount.value).toBe(2)

      // Shuffle and repeat are settings and do survive; the queue is a
      // statement about the next few minutes and deliberately does not.
      expect(storedValue(store.storage, TRANSPORT_REPEAT_KEY)).toBe('all')
      expect(store.storage.entries.size).toBe(1)

      const after = harness({ settings: store.settings })
      expect(after.controller.repeatMode.value).toBe('all')
      expect(after.controller.queuedCount.value).toBe(0)
      expect(after.controller.queuedEntries.value).toEqual([])
    })

    it('rule 6: shuffle reorders the playing playlist and never the user tier', async () => {
      const h = harness({ playlistTotal: 6 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42), track(43), track(44)])
      await settle()
      const entries = [...h.controller.queuedUserEntries.value]
      const linearSession = sessionIds(h.controller)

      await h.controller.setShuffle(true)
      await settle()

      // The order was permuted — and the user tier was not so much as touched.
      // Byte-identical, not merely equal by track id: a refill that happened to
      // mint the same tracks would pass the weaker assertion.
      expect(h.controller.orderId()).toBe('shuffle:1234:0:playlist:7')
      expect(h.controller.queuedUserEntries.value).toEqual(entries)
      expect(userIds(h.controller)).toEqual([42, 43, 44])
      // The head is still what plays next, whatever the permutation says.
      expect(h.controller.prefetchedTrackId.value).toBe(42)

      // The session tier is the half rule 6 gained in the amendment: it claims
      // to describe what is actually going to play, so a reshuffle refills it
      // rather than leaving it showing an order that will not happen.
      const shuffledSession = sessionIds(h.controller)
      expect(shuffledSession).not.toEqual(linearSession)
      expect([...shuffledSession].sort()).toEqual([...linearSession].sort())

      await h.controller.setShuffle(false)
      await settle()
      expect(userIds(h.controller)).toEqual([42, 43, 44])
      expect(sessionIds(h.controller)).toEqual(linearSession)
    })

    it('rule 7: repeat-one overrides the queue at a boundary, and repeat-all wraps while the queue still wins', async () => {
      const h = harness({ playlistTotal: 3 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42)])
      h.controller.setRepeatMode('one')
      await settle()

      // "Repeat-one overrides everything", including a non-empty queue — and
      // without consuming it, or the queue would drain while it looped.
      expect(h.controller.prefetchedTrackId.value).toBe(PLAYLIST_TRACK_BASE)
      h.engine.emit('ended', { trackId: PLAYLIST_TRACK_BASE })
      await settle()
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE)
      expect(userIds(h.controller)).toEqual([42])

      // Pressing Next under repeat-one moves on, and moving on means the queue.
      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(42)
      expect(h.controller.queuedUserCount.value).toBe(0)

      // Repeat-all wraps the playing playlist at its last row — but the queue
      // takes priority over the wrap for as long as it has anything to say.
      const wrap = harness({ playlistTotal: 3 })
      await wrap.controller.playFromPlaylist({ playlistId: 7, index: 2 })
      wrap.controller.setRepeatMode('all')
      wrap.controller.enqueue([track(42)])
      await settle()
      expect(wrap.controller.prefetchedTrackId.value).toBe(42)

      await wrap.controller.next()
      expect(wrap.controller.nowPlaying.value?.id).toBe(42)
      await wrap.controller.next()
      expect(wrap.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE)
    })

    it('plays a queued entry out of turn without disturbing the rest', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      const [, second] = h.controller.enqueue([track(42), track(43), track(44)])
      await settle()

      await h.controller.playQueued(second?.id ?? '')

      expect(h.controller.nowPlaying.value?.id).toBe(43)
      // Only the row that was played leaves. §5 does not choose between this
      // and dropping everything above it, so this destroys nothing. That is
      // the *user* tier's reading and it survives the amendment; a session
      // entry takes the rows above it with it, which is tested separately.
      expect(userIds(h.controller)).toEqual([42, 44])
      expect(h.controller.orderIndex.value).toBe(0)
    })

    it('clears on request, and re-decides the boundary when it does', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(42)])
      await settle()
      expect(h.controller.prefetchedTrackId.value).toBe(42)

      h.controller.clearQueue()
      await settle()

      expect(h.controller.queuedCount.value).toBe(0)
      expect(h.controller.prefetchedTrackId.value).toBe(PLAYLIST_TRACK_BASE + 1)
    })
  })

  /**
   * The session tier — §5 amendment of 2026-07-31.
   *
   * The scope has always bounded traversal; what these prove is that it is now
   * also *visible*, that making it visible did not change what plays, and that
   * the two tiers keep the guarantees rule 3 was written for.
   */
  describe('the session-primed queue (§5 amendment)', () => {
    type Controller = ReturnType<typeof harness>['controller']

    const userIds = (controller: Controller): number[] =>
      controller.queuedUserEntries.value.map((entry) => entry.trackId)

    const sessionIds = (controller: Controller): number[] =>
      controller.queuedSessionEntries.value.map((entry) => entry.trackId)

    it('fills the up-next surface with the scoped rows behind the clicked one', async () => {
      const h = harness({ total: 6 })
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        filters: { artistIds: [3, 7, 11] },
        index: 1,
        track: track(1)
      })
      await settle()

      // Rows 2..5 of the scope, in the visible sort — the tracks that were
      // always going to play and previously had nowhere to be seen.
      expect(sessionIds(h.controller)).toEqual([2, 3, 4, 5])
      expect(userIds(h.controller)).toEqual([])

      // The scope reached the fill, not just the order: a session tier read
      // without the filters would be the whole library rather than the facet.
      expect(h.fetchTrackIds.mock.calls[0]?.[0]).toMatchObject({
        artistIds: [3, 7, 11],
        sort: 'artist',
        direction: 'asc'
      })
    })

    it('plays through the session tier exactly as the order alone did', async () => {
      // The equivalence that says this card changed the surface and not the
      // music. Same fixture, same clicks, and the sequence of audible tracks
      // has to match what traversal produced before the tier existed.
      const h = harness({ total: 5 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()

      const heard = [h.controller.nowPlaying.value?.id]
      for (let step = 0; step < 4; step += 1) {
        await h.controller.next()
        heard.push(h.controller.nowPlaying.value?.id)
      }

      expect(heard).toEqual([0, 1, 2, 3, 4])
      // And the anchor tracked the rows rather than staying pinned to the
      // click, which is what the order index means for a session entry.
      expect(h.controller.orderIndex.value).toBe(4)
      expect(sessionIds(h.controller)).toEqual([])
    })

    it('resumes after the last materialized row when a capped session drains', async () => {
      // The bug the anchor rule exists to prevent, and it is invisible under
      // any scope smaller than the cap: a session tier holding rows 1..N
      // against an anchor still at 0 replays the scope from its second track
      // the moment it drains. Driven with a tiny cap rather than 5,000 rows.
      const h = harness({ total: 40, sessionCap: 3 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      expect(sessionIds(h.controller)).toEqual([1, 2, 3])

      for (let step = 0; step < 3; step += 1) await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(3)
      expect(h.controller.queuedCount.value).toBe(0)

      // Track 4, not track 1. The tier drained and traversal picked up after
      // the last row it had materialized.
      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(4)
      expect(h.controller.orderIndex.value).toBe(4)
    })

    it('leaves hand-queued tracks standing above a new session', async () => {
      // Rule 3 as amended, and the failure the two-tier split exists to
      // prevent: queue five tracks, click a library row, lose them.
      const h = harness({ total: 6 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      const hand = h.controller.enqueue([track(90), track(91), track(92), track(93), track(94)])
      await settle()

      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      await settle()

      expect(h.controller.queuedUserEntries.value).toEqual(hand)
      expect(userIds(h.controller)).toEqual([90, 91, 92, 93, 94])
      // The session tier was replaced rather than appended to — it describes
      // the session that just ended.
      expect(sessionIds(h.controller)).toEqual([
        PLAYLIST_TRACK_BASE + 1,
        PLAYLIST_TRACK_BASE + 2,
        PLAYLIST_TRACK_BASE + 3,
        PLAYLIST_TRACK_BASE + 4,
        PLAYLIST_TRACK_BASE + 5
      ])
      // And the user tier is still what plays next, above all of it.
      expect(h.controller.queuedEntries.value[0]?.trackId).toBe(90)
    })

    it('lands an add above the session tier rather than at the true tail', async () => {
      // Against a loaded session, an append to the true tail means "in four
      // hours", which makes the verb useless.
      const h = harness({ total: 8 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      expect(sessionIds(h.controller)).toEqual([1, 2, 3, 4, 5, 6, 7])

      h.controller.enqueue([track(90)])
      h.controller.enqueue([track(91)])
      h.controller.enqueueNext([track(92)])

      // Play-next at the absolute head, add-to-queue at the tail of the user
      // tier — which is immediately above the first session row.
      expect(userIds(h.controller)).toEqual([92, 90, 91])
      expect(h.controller.queuedEntries.value.slice(0, 4).map((entry) => entry.trackId)).toEqual([
        92, 90, 91, 1
      ])
    })

    it('leaves exactly the second row session queued when two are clicked in quick succession', async () => {
      const h = harness({ total: 20 })
      const first = h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      const second = h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 10 })
      await Promise.all([first, second])
      await settle()

      expect(h.controller.nowPlaying.value?.id).toBe(10)
      expect(sessionIds(h.controller)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19])
    })

    it('does not make the click path wait on the fill', async () => {
      // The fill is several round trips behind the audio, and the click must
      // not be behind the fill. Proved by parking the fill's first read
      // forever rather than by counting microtasks: if playback waited on it,
      // this `await` would never return and the test would time out.
      const h = harness({ total: 6, stallSessionFill: true })
      await h.controller.playFromList({
        sort: 'artist',
        direction: 'asc',
        index: 0,
        track: track(0)
      })
      await settle()

      expect(h.engine.loaded).toEqual([0])
      expect(h.controller.nowPlaying.value?.id).toBe(0)
      expect(h.engine.playCount).toBe(1)
      // The queue is the only thing the stall costs.
      expect(sessionIds(h.controller)).toEqual([])
      expect(h.fetchTrackIds).toHaveBeenCalled()
    })

    it('drops the session rows above a jump and keeps the user tier whole', async () => {
      const h = harness({ total: 8 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      h.controller.enqueue([track(90)])
      const target = h.controller.queuedSessionEntries.value[3]

      await h.controller.playQueued(target?.id ?? '')

      // The anchor moved to the row that was jumped to, because a session entry
      // *is* an order row — and the rows above it are behind the operator now.
      expect(h.controller.nowPlaying.value?.id).toBe(4)
      expect(h.controller.orderIndex.value).toBe(4)
      expect(sessionIds(h.controller)).toEqual([5, 6, 7])
      // The user tier sits above the session tier and is not behind anything.
      expect(userIds(h.controller)).toEqual([90])
    })

    it('steps back to the previous row from a session entry, not onto itself', async () => {
      const h = harness({ total: 6 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(1)

      await h.controller.previous()

      // A session entry is the order row at its index, so Previous means the
      // row before it. Backing out to `index` would replay what is playing —
      // which is what a user detour means and this is not one.
      expect(h.controller.nowPlaying.value?.id).toBe(0)
      expect(h.controller.orderIndex.value).toBe(0)
    })

    it('refills the tier when Previous moves the anchor out from under it', async () => {
      // The tier describes the rows after the anchor, and Previous moves the
      // anchor backwards without consuming anything. Left alone, the tier would
      // still be headed by row 3 against an anchor of 1 — and the next advance
      // would take that head and skip row 2 outright.
      const h = harness({ total: 8 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 2 })
      await settle()
      expect(sessionIds(h.controller)).toEqual([3, 4, 5, 6, 7])

      await h.controller.previous()
      await settle()

      expect(h.controller.orderIndex.value).toBe(1)
      expect(sessionIds(h.controller)).toEqual([2, 3, 4, 5, 6, 7])

      // And the advance that follows plays row 2 rather than jumping to row 3.
      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(2)
      expect(h.controller.orderIndex.value).toBe(2)
    })

    it('stops filling at the end of a short scope', async () => {
      const h = harness({ total: 3 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 1 })
      await settle()

      // Two rows behind the anchor and nothing invented past the end.
      expect(sessionIds(h.controller)).toEqual([2])
      expect(h.controller.queuedCount.value).toBe(1)
    })
  })

  /**
   * W7-4's jump-back, and the one claim the card makes about it: replaying from
   * the trail must not corrupt queue state.
   *
   * It is a **detour** — §5 rule 1's first arm and nothing else. The rows below
   * are that read against every piece of state a jump could plausibly have
   * moved: the playing playlist (rule 3), the anchor (rule 2), and both tiers
   * (rules 3 and 6).
   */
  describe('replaying from the play-history trail', () => {
    const userIds = (controller: ReturnType<typeof harness>['controller']): number[] =>
      controller.queuedUserEntries.value.map((entry) => entry.trackId)

    const sessionIds = (controller: ReturnType<typeof harness>['controller']): number[] =>
      controller.queuedSessionEntries.value.map((entry) => entry.trackId)

    it('plays the track without moving the playing playlist or the anchor', async () => {
      const h = harness({ playlistTotal: 6 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
      await settle()
      expect(h.controller.orderIndex.value).toBe(2)

      // Something heard twenty minutes ago, off the trail. It is not a row of
      // the playing order and does not become one.
      await h.controller.replay(track(555))

      expect(h.controller.nowPlaying.value?.id).toBe(555)
      // Rule 3 is about playing *from* a playlist. This plays from the trail,
      // so the playing playlist is untouched — and with it the crossfade the
      // cascade resolves at that playlist.
      expect(h.controller.playingPlaylistId.value).toBe(7)
      // Rule 2's anchor: a user detour leaves the resume position where it was.
      expect(h.controller.orderIndex.value).toBe(2)
    })

    it('resumes at the row it interrupted when the replayed track ends', async () => {
      const h = harness({ playlistTotal: 6 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2 })
      await settle()

      await h.controller.replay(track(555))
      expect(h.controller.nowPlaying.value?.id).toBe(555)

      // Rule 1's second arm. The detour is over, so the successor is the next
      // row after the one that was interrupted — not the one after the replayed
      // track, which has no position in this order at all.
      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 3)
      expect(h.controller.orderIndex.value).toBe(3)
    })

    it('leaves a hand-built user queue standing, in its order', async () => {
      const h = harness({ playlistTotal: 6 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(90), track(91), track(92)])
      await settle()

      await h.controller.replay(track(555))

      // The whole reason this is a detour rather than a change of scope: ten
      // minutes of queue-building is not something a jump-back may discard.
      expect(userIds(h.controller)).toEqual([90, 91, 92])
      expect(h.controller.nowPlaying.value?.id).toBe(555)
    })

    it('leaves the session tier intact, because the anchor did not move', async () => {
      const h = harness({ total: 8 })
      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      expect(sessionIds(h.controller)).toEqual([1, 2, 3, 4, 5, 6, 7])

      await h.controller.replay(track(555))
      await settle()

      // `sessionIsStale` measures the tier against the anchor, and a user entry
      // carries no `orderIndex` of its own — so there is nothing here to
      // refill, and nothing gets cleared and re-fetched behind the operator.
      expect(sessionIds(h.controller)).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('takes only its own row back out of the queue', async () => {
      const h = harness({ playlistTotal: 6 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      h.controller.enqueue([track(90)])
      await settle()

      await h.controller.replay(track(555))

      // The replayed row is in the queue for exactly as long as it takes to
      // play it — rule 1's shift — and the queue is not left holding a copy.
      expect(userIds(h.controller)).toEqual([90])
      expect(h.controller.queuedEntries.value.some((entry) => entry.trackId === 555)).toBe(false)
    })

    it('starts a one-track order when nothing is playing', async () => {
      // The state the trail is in immediately after a restart: history survives
      // and the transport does not. There is no detour to take and no position
      // to resume, so the fallback is an ordinary start.
      const h = harness()
      expect(h.controller.orderIndex.value).toBeNull()

      await h.controller.replay(track(555))

      expect(h.controller.nowPlaying.value?.id).toBe(555)
      expect(h.controller.playingPlaylistId.value).toBeNull()
      expect(h.controller.orderIndex.value).toBe(0)
      // Nothing invented past the one row it was given.
      await h.controller.next()
      expect(h.controller.nowPlaying.value?.id).toBe(555)
    })

    it('replays the audible track without leaving a queue entry behind', async () => {
      // The pane refuses this gesture on the row marked "Playing", but the
      // controller is reachable from elsewhere and must not strand an entry.
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 1 })
      await settle()
      const playing = h.controller.nowPlaying.value

      await h.controller.replay(playing!)

      expect(h.controller.nowPlaying.value?.id).toBe(playing!.id)
      expect(userIds(h.controller)).toEqual([])
      expect(h.controller.orderIndex.value).toBe(1)
    })
  })

  /**
   * The trail's only route out of playback. A sink rather than a store reached
   * from inside the controller — see `PlaybackControllerDeps.onPlayStarted`.
   */
  describe('reporting plays to the trail', () => {
    it('reports each track as it becomes audible, once', async () => {
      const plays: number[] = []
      const h = harness({ total: 6, onPlayStarted: (played) => plays.push(played.id) })

      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      await h.controller.next()
      await h.controller.next()

      expect(plays).toEqual([0, 1, 2])
    })

    it('reports a skip, which is the case jump-back exists for', async () => {
      const plays: number[] = []
      const h = harness({ total: 6, onPlayStarted: (played) => plays.push(played.id) })

      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      // Three seconds in, and gone. A listened-threshold would drop this row —
      // and it is exactly the one an operator goes looking for afterwards.
      await h.controller.next()

      expect(plays).toEqual([0, 1])
    })

    it('reports a replay, so the trail head is what is audible', async () => {
      const plays: number[] = []
      const h = harness({ playlistTotal: 4, onPlayStarted: (played) => plays.push(played.id) })

      await h.controller.playFromPlaylist({ playlistId: 7, index: 0 })
      await settle()
      await h.controller.replay(track(555))

      expect(plays).toEqual([PLAYLIST_TRACK_BASE, 555])
    })

    it('reports nothing for a shuffle toggle', async () => {
      const plays: number[] = []
      const h = harness({ total: 6, onPlayStarted: (played) => plays.push(played.id) })

      await h.controller.playFromList({ sort: 'artist', direction: 'asc', index: 0 })
      await settle()
      expect(plays).toEqual([0])

      // The audible row keeps playing at a new position. Nothing started, so
      // nothing is a play — see `PlaybackSchedulerEventMap.playstart`.
      h.controller.setShuffle(true)
      await settle()
      h.controller.setShuffle(false)
      await settle()

      expect(plays).toEqual([0])
    })
  })
})
