import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaybackController,
  type PlaybackControllerDeps
} from '../../../src/renderer/playback/controller'
// The contract, not the barrel: these tests compile under the node config,
// which has no DOM, and the barrel reaches the Web Audio implementation.
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type NormalizationMode,
  type PlaybackStatus,
  type SampleAccurateTime
} from '../../../src/renderer/audio/AudioEngine'
import type { ListTracksQuery, ListTracksResult, Track } from '../../../src/shared/library'
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
  normalizationMode: NormalizationMode = 'track'
  status: PlaybackStatus = 'idle'
  trackId: number | null = null
  transitionPolicy = 'sample-accurate' as const
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

  setNormalizationMode(mode: NormalizationMode): void {
    this.normalizationMode = mode
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
    storage?: PlaybackControllerDeps['storage']
    createShuffleSeed?: PlaybackControllerDeps['createShuffleSeed']
    crossfadeMs?: number
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
    ...(options.createMediaSession ? { createMediaSession: options.createMediaSession } : {}),
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.crossfadeMs === undefined ? {} : { crossfadeMs: options.crossfadeMs }),
    // Fixed by default, so a shuffled traversal is something a test can name.
    createShuffleSeed: options.createShuffleSeed ?? ((): number => 1234)
  })
  return { controller, engine: engines[0], engines, fetchPage, fetchPlaylistEntries }
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

      expect(h.engines.every((engine) => engine.normalizationMode === 'album')).toBe(true)
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

  describe('remembering the modes', () => {
    function storage(): PlaybackControllerDeps['storage'] & { value: string | null } {
      return {
        value: null,
        read() {
          return this.value
        },
        write(next: string) {
          this.value = next
        }
      }
    }

    it('restores shuffle and repeat from a previous session', async () => {
      const store = storage()
      const before = harness({ storage: store })
      before.controller.setRepeatMode('one')
      await before.controller.setShuffle(true)

      const after = harness({ storage: store })

      expect(after.controller.repeatMode.value).toBe('one')
      expect(after.controller.shuffleEnabled.value).toBe(true)
    })

    it('runs unbound', () => {
      // Omitting storage is a supported configuration: the modes last for the
      // session, which is what every other test here wants.
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
      broken.fetchPage.mockRejectedValueOnce(new Error('ipc down'))

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
      await h.controller.playFromPlaylist({ playlistId: 7, index: 1, crossfadeMs: 0 })

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
        crossfadeMs: 0,
        track: track(PLAYLIST_TRACK_BASE + 3)
      })

      expect(h.engine.loaded).toEqual([PLAYLIST_TRACK_BASE + 3])
      expect(h.controller.orderIndex.value).toBe(3)
      // As with the list: the row was handed over, so the only lookup is the
      // decode-ahead row.
      expect(h.fetchPlaylistEntries).toHaveBeenCalledTimes(1)
      expect(h.fetchPlaylistEntries).toHaveBeenCalledWith({ playlistId: 7, offset: 4, limit: 1 })
    })

    it('advances through the playlist entries', async () => {
      const h = harness({ playlistTotal: 4 })
      await h.controller.playFromPlaylist({ playlistId: 7, index: 0, crossfadeMs: 0 })
      await h.controller.next()

      expect(h.controller.orderIndex.value).toBe(1)
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 1)
    })

    // §5 rule 3. Nothing else in the controller writes it, and viewing a tab
    // is emphatically not "playing a track from a playlist".
    it('records which playlist is playing, and clears it for the library', async () => {
      const h = harness()
      expect(h.controller.playingPlaylistId.value).toBeNull()

      await h.controller.playFromPlaylist({ playlistId: 7, index: 0, crossfadeMs: 0 })
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
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2, crossfadeMs: 0 })
      await h.controller.next()

      // Position 3 exists in the library fixture and not in the playlist, so a
      // traversal that had leaked into the library would have advanced here.
      expect(h.controller.orderIndex.value).toBe(2)
      expect(h.controller.nowPlaying.value?.id).toBe(PLAYLIST_TRACK_BASE + 2)
    })

    it('wraps at the playlist end under repeat-all, not the library end', async () => {
      const h = harness({ total: 50, playlistTotal: 3 })
      h.controller.setRepeatMode('all')
      await h.controller.playFromPlaylist({ playlistId: 7, index: 2, crossfadeMs: 0 })
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
        await h.controller.playFromPlaylist({ playlistId: 7, index: 2, crossfadeMs: 0 })
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
        await h.controller.playFromPlaylist({ playlistId: 7, index: 2, crossfadeMs: 0 })
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
        await h.controller.playFromPlaylist({ playlistId: 7, index: 1, crossfadeMs: 0 })
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
        await h.controller.playFromPlaylist({ playlistId: 7, index: 1, crossfadeMs: 0 })
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
        await h.controller.playFromPlaylist({ playlistId: 7, index: 1, crossfadeMs: 0 })

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

    describe('the boundary policy', () => {
      it('gives the scheduler the playing playlist crossfade', async () => {
        const h = harness({ crossfadeMs: 250 })
        await h.controller.playFromPlaylist({ playlistId: 7, index: 0, crossfadeMs: 1500 })

        expect(h.controller.crossfadeMs.value).toBe(1500)
        expect(h.controller.schedulerCrossfadeMs()).toBe(1500)
      })

      it('gives the global setting back when the library plays again', async () => {
        const h = harness({ crossfadeMs: 250 })
        await h.controller.playFromPlaylist({ playlistId: 7, index: 0, crossfadeMs: 1500 })
        await h.controller.playFromList({
          sort: 'artist',
          direction: 'asc',
          index: 0,
          track: track(0)
        })

        expect(h.controller.schedulerCrossfadeMs()).toBe(250)
      })

      it('keeps the playlist value while the global setting is changed under it', async () => {
        const h = harness({ crossfadeMs: 250 })
        await h.controller.playFromPlaylist({ playlistId: 7, index: 0, crossfadeMs: 1500 })

        h.controller.setCrossfadeMs(800)

        expect(h.controller.defaultCrossfadeMs.value).toBe(800)
        expect(h.controller.schedulerCrossfadeMs()).toBe(1500)
      })

      it('follows an edit to the playing playlist', async () => {
        const h = harness()
        await h.controller.playFromPlaylist({ playlistId: 7, index: 0, crossfadeMs: 1500 })

        h.controller.playlistCrossfadeChanged(9, 4000)
        expect(h.controller.schedulerCrossfadeMs()).toBe(1500)

        h.controller.playlistCrossfadeChanged(7, 0)
        expect(h.controller.schedulerCrossfadeMs()).toBe(0)
      })
    })
  })
})
