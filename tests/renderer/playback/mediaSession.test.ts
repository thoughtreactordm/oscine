import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import {
  createMediaSessionBinding,
  createMediaSessionSurface,
  MEDIA_SESSION_ACTIONS,
  toMediaMetadata,
  toPlaybackState,
  toPositionState,
  type MediaMetadataDescriptor,
  type MediaPositionState,
  type MediaSessionActionDetails,
  type MediaArtworkDescriptor,
  type MediaSessionActionName,
  type MediaSessionAnchor,
  type MediaSessionPlaybackState,
  type MediaSessionSurface,
  type NativeMediaSession
} from '../../../src/renderer/playback/mediaSession'
import type { PlaybackStatus } from '../../../src/renderer/audio/AudioEngine'
import type { Track } from '../../../src/shared/library'

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    rootId: 1,
    title: 'Kind of Blue',
    artist: 'Miles Davis',
    album: 'Kind of Blue',
    albumArtist: 'Miles Davis Quintet',
    trackNo: 1,
    discNo: null,
    year: 1959,
    durationSec: 545,
    codec: 'flac',
    encodedBytes: 40_000_000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

const COVERED = {
  small: 'fermata://artwork/abc123/small',
  large: 'fermata://artwork/abc123/large'
}

/** Records everything handed to the OS, and lets a test fire an action back. */
class FakeSurface implements MediaSessionSurface {
  metadata: MediaMetadataDescriptor | null = null
  playbackState: MediaSessionPlaybackState = 'none'
  readonly positions: Array<MediaPositionState | null> = []
  readonly handlers = new Map<
    MediaSessionActionName,
    ((details: MediaSessionActionDetails) => void) | null
  >()

  setMetadata(metadata: MediaMetadataDescriptor | null): void {
    this.metadata = metadata
  }

  setPlaybackState(state: MediaSessionPlaybackState): void {
    this.playbackState = state
  }

  setPositionState(state: MediaPositionState | null): void {
    this.positions.push(state)
  }

  setActionHandler(
    action: MediaSessionActionName,
    handler: ((details: MediaSessionActionDetails) => void) | null
  ): void {
    this.handlers.set(action, handler)
  }

  invoke(action: MediaSessionActionName, details: MediaSessionActionDetails = {}): void {
    const handler = this.handlers.get(action)
    if (!handler) throw new Error(`no handler registered for ${action}`)
    handler(details)
  }
}

class FakeAnchor implements MediaSessionAnchor {
  playing = false
  disposed = false
  playCount = 0
  pauseCount = 0

  play(): Promise<void> {
    this.playCount += 1
    this.playing = true
    return Promise.resolve()
  }

  pause(): void {
    this.pauseCount += 1
    this.playing = false
  }

  dispose(): void {
    this.disposed = true
    this.playing = false
  }
}

function harness() {
  const state = {
    status: ref<PlaybackStatus>('idle'),
    nowPlaying: ref<Track | null>(null),
    currentTime: ref(0),
    duration: ref(0),
    scrubbing: ref(false)
  }
  const transport = {
    resume: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    stop: vi.fn(),
    next: vi.fn(() => Promise.resolve()),
    previous: vi.fn(() => Promise.resolve()),
    seek: vi.fn()
  }
  const surface = new FakeSurface()
  const anchors: FakeAnchor[] = []
  let clockMs = 0

  const binding = createMediaSessionBinding({
    platform: {
      surface,
      createAnchor: () => {
        const anchor = new FakeAnchor()
        anchors.push(anchor)
        return anchor
      }
    },
    state,
    transport,
    now: () => clockMs
  })

  return {
    state,
    transport,
    surface,
    anchors,
    binding,
    advance: (seconds: number): void => {
      clockMs += seconds * 1000
    },
    /** The controller writes refs; the watchers run on the pre-flush queue. */
    settle: (): Promise<void> => nextTick()
  }
}

describe('toPlaybackState', () => {
  it('maps a sounding engine to playing', () => {
    expect(toPlaybackState('playing', true)).toBe('playing')
  })

  it.each<PlaybackStatus>(['paused', 'ready', 'ended'])(
    'reports %s as paused, because a loaded track that is not sounding is a paused player',
    (status) => {
      expect(toPlaybackState(status, true)).toBe('paused')
    }
  )

  it('withdraws the session only when nothing is loaded', () => {
    expect(toPlaybackState('idle', false)).toBe('none')
    expect(toPlaybackState('loading', false)).toBe('none')
  })

  it('keeps the card up while loading a track that replaces one already showing', () => {
    // Otherwise the OS card blinks out and back at every skip.
    expect(toPlaybackState('loading', true)).toBe('paused')
  })
})

describe('toMediaMetadata', () => {
  it('advertises both artwork variants when the album has a cover', () => {
    expect(toMediaMetadata(track({ artwork: COVERED })).artwork).toEqual([
      { src: COVERED.small, sizes: '160x160', type: 'image/webp' },
      { src: COVERED.large, sizes: '640x640', type: 'image/webp' }
    ])
  })

  it('advertises no artwork rather than the placeholder', () => {
    // A flat grey square is right inside Fermata and wrong in a shell widget,
    // which falls back to the application icon when given nothing.
    expect(toMediaMetadata(track()).artwork).toEqual([])
  })

  it('falls back to the album artist when the track carries none', () => {
    expect(toMediaMetadata(track({ artist: null })).artist).toBe('Miles Davis Quintet')
  })

  it('reports empty strings rather than nulls for absent tags', () => {
    const metadata = toMediaMetadata(track({ artist: null, albumArtist: null, album: null }))
    expect(metadata.artist).toBe('')
    expect(metadata.album).toBe('')
  })
})

describe('toPositionState', () => {
  it('reports nothing when the duration is not yet known', () => {
    expect(toPositionState(0, 0)).toBeNull()
    expect(toPositionState(Number.NaN, 0)).toBeNull()
    expect(toPositionState(Number.POSITIVE_INFINITY, 0)).toBeNull()
  })

  it('clamps the position into the track, because Chromium throws otherwise', () => {
    expect(toPositionState(120, 500)).toEqual({ duration: 120, position: 120, playbackRate: 1 })
    expect(toPositionState(120, -3)).toEqual({ duration: 120, position: 0, playbackRate: 1 })
  })
})

/**
 * `navigator.mediaSession` plus the browser bits the surface needs, with the
 * artwork read held open so a test can decide when — and whether — it lands.
 */
function surfaceHarness() {
  const session: NativeMediaSession = {
    metadata: null,
    playbackState: 'none',
    setPositionState: vi.fn(),
    setActionHandler: vi.fn()
  }
  const pending: Array<{
    image: MediaArtworkDescriptor
    settle: (result: MediaArtworkDescriptor | null) => void
  }> = []
  const released: string[] = []
  let issued = 0

  const surface = createMediaSessionSurface({
    session,
    createMetadata: (init) => init,
    loadArtwork: (image) =>
      new Promise((resolve) => {
        pending.push({ image, settle: resolve })
      }),
    releaseArtwork: (url) => released.push(url)
  })

  return {
    session,
    surface,
    released,
    /** Completes every outstanding read with a fresh blob-shaped URL. */
    async settleAll(): Promise<void> {
      const outstanding = pending.splice(0, pending.length)
      for (const entry of outstanding) {
        entry.settle({ ...entry.image, src: `blob:resolved-${(issued += 1)}` })
      }
      await Promise.resolve()
      await Promise.resolve()
    },
    outstanding: (): number => pending.length,
    /** What the surface last handed the OS, as the descriptor we faked. */
    metadata: (): MediaMetadataDescriptor | null =>
      session.metadata as MediaMetadataDescriptor | null
  }
}

const withArt = (title: string, routes: string[]): MediaMetadataDescriptor => ({
  title,
  artist: 'Miles Davis',
  album: 'Kind of Blue',
  artwork: routes.map((src) => ({ src, sizes: '640x640', type: 'image/webp' }))
})

describe('media session surface', () => {
  it('publishes the tags before the artwork has been read', () => {
    // A track change must not hold the title hostage to an image read.
    const h = surfaceHarness()
    h.surface.setMetadata(withArt('So What', ['fermata://artwork/a/large']))

    expect(h.metadata()?.title).toBe('So What')
    expect(h.metadata()?.artwork).toEqual([])
    expect(h.outstanding()).toBe(1)
  })

  it('re-addresses artwork, because Chromium refuses the fermata scheme', async () => {
    const h = surfaceHarness()
    h.surface.setMetadata(withArt('So What', ['fermata://artwork/a/large']))
    await h.settleAll()

    expect(h.metadata()?.artwork).toEqual([
      { src: 'blob:resolved-1', sizes: '640x640', type: 'image/webp' }
    ])
  })

  it('reuses the resolution across an album rather than blinking the cover', async () => {
    // Every track on an album carries the same routes. Re-reading them would
    // republish with no artwork first, at every gapless boundary.
    const h = surfaceHarness()
    h.surface.setMetadata(withArt('So What', ['fermata://artwork/a/large']))
    await h.settleAll()

    h.surface.setMetadata(withArt('Blue in Green', ['fermata://artwork/a/large']))

    expect(h.outstanding()).toBe(0)
    expect(h.metadata()?.title).toBe('Blue in Green')
    expect(h.metadata()?.artwork).toEqual([
      { src: 'blob:resolved-1', sizes: '640x640', type: 'image/webp' }
    ])
    expect(h.released).toEqual([])
  })

  it('releases the previous resolution when the cover changes', async () => {
    const h = surfaceHarness()
    h.surface.setMetadata(withArt('So What', ['fermata://artwork/a/large']))
    await h.settleAll()
    h.surface.setMetadata(withArt('Flamenco Sketches', ['fermata://artwork/b/large']))
    await h.settleAll()

    expect(h.released).toEqual(['blob:resolved-1'])
    expect(h.metadata()?.artwork[0]?.src).toBe('blob:resolved-2')
  })

  it('discards a read whose track has already been skipped past', async () => {
    const h = surfaceHarness()
    h.surface.setMetadata(withArt('So What', ['fermata://artwork/a/large']))
    h.surface.setMetadata(withArt('Flamenco Sketches', ['fermata://artwork/b/large']))
    await h.settleAll()

    // Both reads land together; only the surviving track's may be published,
    // and the stale one must still be released rather than leaked.
    expect(h.metadata()?.title).toBe('Flamenco Sketches')
    expect(h.metadata()?.artwork[0]?.src).toBe('blob:resolved-2')
    expect(h.released).toEqual(['blob:resolved-1'])
  })

  it('releases everything when playback stops', async () => {
    const h = surfaceHarness()
    h.surface.setMetadata(withArt('So What', ['fermata://artwork/a/large']))
    await h.settleAll()
    h.surface.setMetadata(null)

    expect(h.session.metadata).toBeNull()
    expect(h.released).toEqual(['blob:resolved-1'])
  })

  it('keeps the card when a cover cannot be read at all', async () => {
    const h = surfaceHarness()
    h.surface.setMetadata(withArt('So What', ['fermata://artwork/missing/large']))
    await h.settleAll()

    expect(h.metadata()?.title).toBe('So What')
  })

  it('survives an action this runtime has never heard of', () => {
    const h = surfaceHarness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(h.session.setActionHandler).mockImplementation(() => {
      throw new TypeError('unsupported action')
    })

    expect(() => h.surface.setActionHandler('seekto', () => {})).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[media-session] this runtime does not support the "seekto" action'
    )
    warn.mockRestore()
  })

  it('clears a stale position with no argument, as the API requires', () => {
    const h = surfaceHarness()
    h.surface.setPositionState(null)
    expect(h.session.setPositionState).toHaveBeenCalledWith()
  })
})

describe('media session binding', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('publishes no session, and builds no anchor, while idle', () => {
    const { surface, anchors, binding } = harness()
    expect(surface.playbackState).toBe('none')
    expect(anchors).toHaveLength(0)
    expect(binding.hasAnchor()).toBe(false)
  })

  it('registers a handler for every action it intends to honour', () => {
    // An unregistered action falls through to Chromium's default handling of
    // the anchor, which would pause silence and diverge the two states.
    const { surface } = harness()
    for (const action of MEDIA_SESSION_ACTIONS) {
      expect(surface.handlers.get(action)).toBeTypeOf('function')
    }
  })

  it('builds the anchor and plays it when the engine starts', async () => {
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.status.value = 'playing'
    await h.settle()

    expect(h.anchors).toHaveLength(1)
    expect(h.anchors[0]!.playing).toBe(true)
    expect(h.surface.playbackState).toBe('playing')
  })

  it('pauses rather than releases the anchor when playback stops', async () => {
    // Releasing it is what W3-10 specified and what the platform punishes:
    // Chromium reports the last player state it observed, so an element torn
    // down mid-play strands the OS card on "Playing". See `syncAnchor`.
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.status.value = 'playing'
    await h.settle()
    h.state.status.value = 'paused'
    await h.settle()

    expect(h.anchors[0]!.playing).toBe(false)
    expect(h.anchors[0]!.disposed).toBe(false)
    expect(h.surface.playbackState).toBe('paused')

    h.state.nowPlaying.value = null
    h.state.status.value = 'idle'
    await h.settle()

    expect(h.anchors[0]!.playing).toBe(false)
    expect(h.anchors[0]!.disposed).toBe(false)
    expect(h.surface.playbackState).toBe('none')
  })

  it('builds no second anchor when playback restarts after a stop', async () => {
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.status.value = 'playing'
    await h.settle()
    h.state.status.value = 'idle'
    await h.settle()
    h.state.status.value = 'playing'
    await h.settle()

    expect(h.anchors).toHaveLength(1)
    expect(h.anchors[0]!.playing).toBe(true)
  })

  it('degrades to a logged fault when the OS asks to play before any gesture', async () => {
    const h = harness()
    const failing: MediaSessionAnchor = {
      play: () => Promise.reject(new Error('play() failed because the user did not interact')),
      pause: () => {},
      dispose: () => {}
    }
    const solo = createMediaSessionBinding({
      platform: { surface: h.surface, createAnchor: () => failing },
      state: h.state,
      transport: h.transport
    })

    h.state.nowPlaying.value = track()
    h.state.status.value = 'playing'
    await h.settle()
    await Promise.resolve()

    expect(warn).toHaveBeenCalledWith(
      '[media-session] silent anchor refused to play:',
      expect.any(Error)
    )
    solo.dispose()
  })

  it('sets metadata on every track change', async () => {
    const h = harness()
    h.state.nowPlaying.value = track({ artwork: COVERED })
    await h.settle()
    expect(h.surface.metadata?.title).toBe('Kind of Blue')

    h.state.nowPlaying.value = track({ id: 2, title: 'Blue in Green' })
    await h.settle()
    expect(h.surface.metadata?.title).toBe('Blue in Green')
  })

  it('freezes the card on the last track when playback stops', async () => {
    // Blanking it does not remove the OS card — Chromium keeps the session and
    // falls back to the document title and the anchor's own duration.
    const h = harness()
    h.state.nowPlaying.value = track({ title: 'Blue in Green' })
    h.state.duration.value = 337
    h.state.status.value = 'playing'
    await h.settle()

    h.state.nowPlaying.value = null
    h.state.duration.value = 0
    h.state.status.value = 'idle'
    await h.settle()

    expect(h.surface.metadata?.title).toBe('Blue in Green')
    expect(h.surface.positions.at(-1)).toEqual({
      duration: 337,
      position: 0,
      playbackRate: 1
    })
    expect(h.surface.playbackState).toBe('none')
  })

  it('publishes position on load and on play/pause, and never on ordinary progress', async () => {
    const h = harness()
    h.surface.positions.length = 0

    h.state.nowPlaying.value = track()
    h.state.duration.value = 545
    await h.settle()
    expect(h.surface.positions).toHaveLength(1) // load

    h.state.status.value = 'playing'
    await h.settle()
    expect(h.surface.positions).toHaveLength(2) // play

    // Ordinary progress: the clock and the position advance together, and
    // Chromium extrapolates between updates. Republishing here is what makes
    // the OS scrubber jitter against its own interpolation.
    for (const at of [0.25, 0.5, 0.75, 1, 1.25]) {
      h.advance(0.25)
      h.state.currentTime.value = at
      await h.settle()
    }
    expect(h.surface.positions).toHaveLength(2)

    h.state.status.value = 'paused'
    await h.settle()
    expect(h.surface.positions).toHaveLength(3) // pause
  })

  it('publishes position when the time signal jumps, which is how a seek is caught', async () => {
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.duration.value = 545
    h.state.status.value = 'playing'
    await h.settle()
    h.surface.positions.length = 0

    h.advance(0.25)
    h.state.currentTime.value = 300
    await h.settle()

    expect(h.surface.positions).toEqual([{ duration: 545, position: 300, playbackRate: 1 }])
  })

  it('stays quiet while the seek handle is held', async () => {
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.duration.value = 545
    h.state.status.value = 'playing'
    await h.settle()
    h.surface.positions.length = 0

    h.state.scrubbing.value = true
    for (const at of [100, 180, 240]) {
      h.state.currentTime.value = at
      await h.settle()
    }
    expect(h.surface.positions).toHaveLength(0)

    // Release commits, the engine reports the new position, and that jump is
    // the one worth telling the OS about.
    h.state.scrubbing.value = false
    h.state.currentTime.value = 240
    h.advance(0.1)
    h.state.currentTime.value = 240.1
    await h.settle()
    expect(h.surface.positions).toHaveLength(1)
  })

  it('routes each OS action to the matching transport intent', async () => {
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.duration.value = 545
    h.state.currentTime.value = 120
    await h.settle()

    h.surface.invoke('play')
    h.surface.invoke('nexttrack')
    h.surface.invoke('previoustrack')
    h.surface.invoke('stop')
    h.surface.invoke('seekto', { seekTime: 42 })

    expect(h.transport.resume).toHaveBeenCalledTimes(1)
    expect(h.transport.next).toHaveBeenCalledTimes(1)
    expect(h.transport.previous).toHaveBeenCalledTimes(1)
    expect(h.transport.stop).toHaveBeenCalledTimes(1)
    expect(h.transport.seek).toHaveBeenCalledWith(42)
  })

  it('ignores a seekto carrying no time rather than seeking to NaN', async () => {
    const h = harness()
    h.surface.invoke('seekto', {})
    expect(h.transport.seek).not.toHaveBeenCalled()
  })

  it('moves by ten seconds when the OS names no seek offset', async () => {
    const h = harness()
    h.state.currentTime.value = 120
    await h.settle()

    h.surface.invoke('seekforward')
    expect(h.transport.seek).toHaveBeenLastCalledWith(130)
    h.surface.invoke('seekbackward')
    expect(h.transport.seek).toHaveBeenLastCalledWith(110)
    h.surface.invoke('seekbackward', { seekOffset: 30 })
    expect(h.transport.seek).toHaveBeenLastCalledWith(90)
  })

  it('pauses once when the OS pause reaches it twice', async () => {
    // The R1 streaming fallback puts a second real player in the session, so a
    // single OS pause can arrive twice. `pause` is an intent, never a toggle:
    // two of them settle on paused rather than cancelling out.
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.status.value = 'playing'
    await h.settle()

    h.surface.invoke('pause')
    h.surface.invoke('pause')

    expect(h.transport.pause).toHaveBeenCalledTimes(2)
    expect(h.transport.resume).not.toHaveBeenCalled()
  })

  it('releases the session, the handlers and the anchor on dispose', async () => {
    const h = harness()
    h.state.nowPlaying.value = track()
    h.state.status.value = 'playing'
    await h.settle()

    h.binding.dispose()

    expect(h.anchors[0]!.disposed).toBe(true)
    expect(h.surface.playbackState).toBe('none')
    expect(h.surface.metadata).toBeNull()
    expect(h.surface.positions.at(-1)).toBeNull()
    for (const action of MEDIA_SESSION_ACTIONS) {
      expect(h.surface.handlers.get(action)).toBeNull()
    }
  })

  it('stops mirroring state after dispose', async () => {
    const h = harness()
    h.binding.dispose()

    h.state.nowPlaying.value = track()
    h.state.status.value = 'playing'
    await h.settle()

    expect(h.surface.playbackState).toBe('none')
    expect(h.surface.metadata).toBeNull()
    expect(h.anchors).toHaveLength(0)
  })
})
