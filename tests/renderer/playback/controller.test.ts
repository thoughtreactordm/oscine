import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackController } from '../../../src/renderer/playback/controller'
// The contract, not the barrel: these tests compile under the node config,
// which has no DOM, and the barrel reaches the Web Audio implementation.
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type PlaybackStatus
} from '../../../src/renderer/audio/AudioEngine'
import type { ListTracksQuery, ListTracksResult, Track } from '../../../src/shared/library'

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
    bitDepth: 16
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
  status: PlaybackStatus = 'idle'
  trackId: number | null = null

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

function harness(options: { total?: number; manualLoad?: boolean } = {}) {
  const total = options.total ?? 10
  const engine = new FakeEngine(options.manualLoad ?? false)
  const fetchPage = vi.fn(async (query: ListTracksQuery): Promise<ListTracksResult> => ({
    tracks: Array.from(
      { length: Math.max(0, Math.min(query.limit, total - query.offset)) },
      (_, i) => track(query.offset + i)
    ),
    total
  }))

  const controller = createPlaybackController({ createEngine: () => engine, fetchPage })
  return { controller, engine, fetchPage }
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
      // The row was handed over, so no round trip was needed for it.
      expect(h.fetchPage).not.toHaveBeenCalled()
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
      expect(h.engine.loaded).toEqual([2, 3])
    })

    it('steps back to the preceding row', async () => {
      await h.controller.previous()

      expect(h.controller.orderIndex.value).toBe(1)
      expect(h.engine.loaded).toEqual([2, 1])
    })

    it('keeps traversing the ordering it started with, not whatever is browsed now', async () => {
      // Design §5: browsing must not disturb playback. Re-sorting the list is a
      // change to what is viewed; the play order was snapshotted at play time.
      await h.controller.next()

      expect(h.fetchPage).toHaveBeenLastCalledWith({
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

      expect(h.engine.loaded).toEqual([0, 2])
      expect(h.engine.playCount).toBe(playsBefore + 1)
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
      slow.engine.settleLoad(1)
      await settle()
      slow.engine.settleLoad(0)
      await settle()

      expect(slow.engine.playCount).toBe(1)
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

    it('does not advance on its own when a track ends', () => {
      // M1 stops at the end of a track; the queue that reacts to this is W5's.
      h.engine.emit('ended', { trackId: 0 })

      expect(h.engine.loaded).toEqual([0])
      expect(h.controller.orderIndex.value).toBe(0)
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
})
