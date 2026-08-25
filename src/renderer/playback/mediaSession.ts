import { watch, type Ref } from 'vue'
import { hasArtwork } from '@shared/ipc'
import type { Track } from '@shared/library'
// The contract module, not the `audio/` barrel — same reason `controller.ts`
// names it directly. Nothing here may drag Web Audio into a node-config compile.
import type { PlaybackStatus } from '../audio/AudioEngine'

/**
 * The OS now-playing surface: Windows SMTC and Linux MPRIS.
 *
 * We write no WinRT and no D-Bus. Chromium implements both backends and feeds
 * them from `navigator.mediaSession`, and Electron inherits the lot. What this
 * module owns is everything above that API: what the OS is told, when it is
 * told, and the silent anchor element that makes Chromium believe a player
 * exists at all.
 *
 * **Why an anchor.** Chromium populates its media session from
 * `HTMLMediaElement` players. `DecodedAudioEngine` — the D2 path, which is to
 * say the normal path — schedules `AudioBufferSourceNode`s, so as far as
 * Chromium is concerned Oscine plays nothing: handlers register and never
 * fire, no SMTC card appears, no MPRIS bus name is published. A silent looping
 * `<audio>` element playing in lockstep with the engine is the standard fix.
 * See `browserMediaSession.ts` for the three non-obvious constraints on it.
 *
 * This is OS presentation, not audio output, which is why it lives beside the
 * scheduler rather than behind `AudioEngine`. The engine interface stays free
 * of Web Audio types (its whole point) and would gain nothing from owning a
 * second view onto state the controller already publishes.
 *
 * The DOM lives in `browserMediaSession.ts`. Everything here is structural
 * interfaces and plain values, so the mapping rules and the anchor lifecycle
 * are testable under plain Node with no `navigator` and no `Audio`.
 */

/** The subset of Media Session actions Oscine honours. */
export const MEDIA_SESSION_ACTIONS = [
  'play',
  'pause',
  'stop',
  'previoustrack',
  'nexttrack',
  'seekbackward',
  'seekforward',
  'seekto'
] as const

export type MediaSessionActionName = (typeof MEDIA_SESSION_ACTIONS)[number]

/** What the OS sends with a seek action. Mirrors `MediaSessionActionDetails`. */
export interface MediaSessionActionDetails {
  seekTime?: number
  seekOffset?: number
  fastSeek?: boolean
}

export type MediaSessionPlaybackState = 'none' | 'paused' | 'playing'

/** One entry of `MediaMetadata.artwork`. */
export interface MediaArtworkDescriptor {
  src: string
  sizes: string
  type: string
}

export interface MediaMetadataDescriptor {
  title: string
  artist: string
  album: string
  artwork: MediaArtworkDescriptor[]
}

export interface MediaPositionState {
  duration: number
  position: number
  playbackRate: number
}

/**
 * `navigator.mediaSession`, narrowed to what we use.
 *
 * Setters rather than properties so the fake in tests is a plain object and so
 * the DOM `MediaMetadata` constructor — which only exists in a browser — stays
 * on the far side of this seam.
 */
export interface MediaSessionSurface {
  setMetadata(metadata: MediaMetadataDescriptor | null): void
  setPlaybackState(state: MediaSessionPlaybackState): void
  setPositionState(state: MediaPositionState | null): void
  setActionHandler(
    action: MediaSessionActionName,
    handler: ((details: MediaSessionActionDetails) => void) | null
  ): void
}

/** The silent element whose playback is the thing Chromium actually observes. */
export interface MediaSessionAnchor {
  play(): Promise<void>
  pause(): void
  /**
   * Release the element for good. Reserved for controller teardown: stopping
   * playback pauses the anchor instead, for the reason recorded on `syncAnchor`.
   */
  dispose(): void
}

export interface MediaSessionPlatform {
  readonly surface: MediaSessionSurface
  createAnchor(): MediaSessionAnchor
}

/** The mutable half of `navigator.mediaSession`, without the DOM types. */
export interface NativeMediaSession {
  metadata: unknown
  playbackState: MediaSessionPlaybackState
  setPositionState(state?: MediaPositionState): void
  setActionHandler(
    action: string,
    handler: ((details: MediaSessionActionDetails) => void) | null
  ): void
}

export interface MediaSessionSurfaceDeps {
  session: NativeMediaSession
  /** `new MediaMetadata(init)`. */
  createMetadata: (init: MediaMetadataDescriptor) => unknown
  /**
   * Reads an artwork route and returns it re-addressed as something the OS will
   * accept, or `null` if it cannot be read. See the note on
   * `createMediaSessionSurface`.
   */
  loadArtwork: (image: MediaArtworkDescriptor) => Promise<MediaArtworkDescriptor | null>
  /** Releases a URL previously produced by `loadArtwork`. */
  releaseArtwork: (url: string) => void
}

/**
 * Adapts `navigator.mediaSession` into the surface the binding drives.
 *
 * Almost all of this is one problem: **Chromium will not accept our artwork
 * routes.** W3-10 assumed the privileged `oscine://` scheme would be enough,
 * since `registerTrackScheme` declares it `standard`, `secure`,
 * `supportFetchAPI` and `corsEnabled`. It is not.
 * `scripts/media-session-probe.mjs` settles it — Chromium answers a custom
 * scheme with
 *
 *   MediaImage src can only be of http/https/data/blob scheme
 *
 * and publishes no `mpris:artUrl` at all. Re-addressed as a blob the same bytes
 * are accepted, and Chromium materialises them into the temporary file MPRIS
 * requires. Only `MediaImage` is fussy; `fetch` still reaches the scheme, so
 * the whole fix costs one local request per cover.
 *
 * Which is why the resolution is cached against the routes that produced it.
 * Every track on an album carries the same two routes, and re-reading them per
 * track would blink the cover out of the OS card at every gapless boundary —
 * the metadata has to be published before the images can possibly have loaded.
 */
export function createMediaSessionSurface(deps: MediaSessionSurfaceDeps): MediaSessionSurface {
  const { session, createMetadata } = deps

  /** Strands an in-flight load whose track has already been replaced. */
  let generation = 0
  /** The routes behind `resolved`, so an album's next track reuses them. */
  let resolvedFor: string[] = []
  let resolved: MediaArtworkDescriptor[] = []

  function release(): void {
    for (const image of resolved) deps.releaseArtwork(image.src)
    resolved = []
    resolvedFor = []
  }

  const sameRoutes = (routes: string[]): boolean =>
    routes.length === resolvedFor.length && routes.every((route, i) => route === resolvedFor[i])

  return {
    setMetadata(metadata: MediaMetadataDescriptor | null): void {
      const token = ++generation

      if (!metadata) {
        session.metadata = null
        release()
        return
      }

      const routes = metadata.artwork.map((image) => image.src)
      if (sameRoutes(routes)) {
        session.metadata = createMetadata({ ...metadata, artwork: resolved })
        return
      }

      // Publish the tags now. A track change must not hold the title and artist
      // hostage to an image read, however local that read is.
      session.metadata = createMetadata({ ...metadata, artwork: [] })
      if (routes.length === 0) {
        release()
        return
      }

      void Promise.all(metadata.artwork.map((image) => deps.loadArtwork(image))).then((loaded) => {
        const next = loaded.filter((image): image is MediaArtworkDescriptor => image !== null)
        if (token !== generation) {
          for (const image of next) deps.releaseArtwork(image.src)
          return
        }
        release()
        resolved = next
        resolvedFor = routes
        session.metadata = createMetadata({ ...metadata, artwork: next })
      })
    },

    setPlaybackState(state: MediaSessionPlaybackState): void {
      session.playbackState = state
    },

    setPositionState(state: MediaPositionState | null): void {
      // No argument is how the API clears a stale position.
      if (state) session.setPositionState(state)
      else session.setPositionState()
    },

    setActionHandler(
      action: MediaSessionActionName,
      handler: ((details: MediaSessionActionDetails) => void) | null
    ): void {
      try {
        session.setActionHandler(action, handler)
      } catch {
        // An action this Chromium does not know throws rather than no-ops.
        // Losing one button is not a reason to lose the whole session.
        console.warn(`[media-session] this runtime does not support the "${action}" action`)
      }
    }
  }
}

/**
 * The transport the OS drives.
 *
 * `resume` and `pause` rather than a single `toggle` is load-bearing, not
 * tidiness. When a track is on the R1 streaming fallback its real
 * `HTMLAudioElement` is a session participant alongside the anchor, so an OS
 * pause can reach the engine twice. Idempotent intents converge on one state;
 * a toggle would cancel itself out and resume playback on a pause.
 */
export interface MediaSessionTransport {
  resume(): Promise<void>
  pause(): void
  stop(): void
  next(): Promise<void>
  previous(): Promise<void>
  seek(seconds: number): void
}

/** The playback state the binding mirrors. Supplied as the controller's refs. */
export interface MediaSessionState {
  status: Ref<PlaybackStatus>
  nowPlaying: Ref<Track | null>
  currentTime: Ref<number>
  duration: Ref<number>
  scrubbing: Ref<boolean>
}

export interface MediaSessionBindingDeps {
  platform: MediaSessionPlatform
  state: MediaSessionState
  transport: MediaSessionTransport
  /** Injected so the seek detector below is testable without a real clock. */
  now?: () => number
}

export interface MediaSessionBinding {
  dispose(): void
  /** Test seam: whether the anchor element currently exists. */
  hasAnchor(): boolean
}

/** What `seekbackward` / `seekforward` move by when the OS names no offset. */
const DEFAULT_SEEK_OFFSET_SEC = 10

/**
 * How far `currentTime` may diverge from its own extrapolation before the jump
 * counts as a seek rather than ordinary progress.
 *
 * `timeupdate` arrives a few times a second, so honest drift is well under a
 * second even across a slow frame. Anything larger is a discontinuity.
 */
const SEEK_DISCONTINUITY_SEC = 1.5

/**
 * Maps engine status onto what the OS should show.
 *
 * The two interesting cases are the ones that are easy to get wrong by
 * defaulting:
 *
 * - `ready` and `ended` are `paused`. Both are a loaded track that is not
 *   sounding, which is exactly what a paused player is; `none` would tear the
 *   card down at the end of every track.
 * - `loading` is `none` only on a cold start. Once a track is showing, a
 *   `loading` pass is a track *transition* — reporting `none` there blinks the
 *   OS card out and back at every skip.
 */
export function toPlaybackState(
  status: PlaybackStatus,
  hasTrack: boolean
): MediaSessionPlaybackState {
  switch (status) {
    case 'playing':
      return 'playing'
    case 'paused':
    case 'ready':
    case 'ended':
      return 'paused'
    case 'loading':
      return hasTrack ? 'paused' : 'none'
    case 'idle':
      return 'none'
  }
}

/**
 * Builds `MediaMetadata` from a track.
 *
 * Both artwork variants are advertised because SMTC wants something reasonably
 * large while a DE widget wants a thumbnail. They are the ordinary
 * `oscine://artwork/...` routes — the domain value — and the platform layer
 * re-wraps them, because `MediaImage` rejects custom schemes outright no matter
 * how the scheme is privileged. See `browserMediaSession.ts`.
 *
 * The placeholder route is deliberately *not* advertised. It is a real image,
 * which is the right answer inside Oscine, but handing the OS a flat grey
 * square is worse than handing it nothing — with no artwork the shell falls
 * back to the application icon, which is more informative.
 */
export function toMediaMetadata(track: Track): MediaMetadataDescriptor {
  const artwork: MediaArtworkDescriptor[] = []
  if (hasArtwork(track.artwork.small)) {
    artwork.push({ src: track.artwork.small, sizes: '160x160', type: 'image/webp' })
  }
  if (hasArtwork(track.artwork.large)) {
    artwork.push({ src: track.artwork.large, sizes: '640x640', type: 'image/webp' })
  }

  return {
    title: track.title,
    // Album artist is the honest fallback for a track whose own artist tag is
    // missing; an empty artist line reads as a metadata bug to the user.
    artist: track.artist ?? track.albumArtist ?? '',
    album: track.album ?? '',
    artwork
  }
}

/**
 * Builds a position state, or `null` when there is nothing coherent to report.
 *
 * Chromium throws on a non-finite or negative duration and on a position past
 * the end, and an exception here would take the whole status watcher with it.
 */
export function toPositionState(
  durationSec: number,
  currentTimeSec: number
): MediaPositionState | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null
  const position = Number.isFinite(currentTimeSec)
    ? Math.min(Math.max(currentTimeSec, 0), durationSec)
    : 0
  return { duration: durationSec, position, playbackRate: 1 }
}

/**
 * Binds the playback controller to the OS media session.
 *
 * Position is published on load, on seek and on play/pause **only**. Chromium
 * extrapolates between updates, so driving `setPositionState` from `timeupdate`
 * both burns cycles and makes the OS scrubber jitter against its own
 * interpolation. Seeks are recovered from the time signal rather than reported
 * by the call sites: a position that disagrees with its own extrapolation by
 * more than `SEEK_DISCONTINUITY_SEC` is a jump, and that catches keyboard
 * seeks, scrub releases and OS-initiated `seekto` alike without every transport
 * caller having to remember to tell us.
 */
export function createMediaSessionBinding(deps: MediaSessionBindingDeps): MediaSessionBinding {
  const { platform, state, transport } = deps
  const now = deps.now ?? Date.now
  const { surface } = platform

  let anchor: MediaSessionAnchor | null = null
  let disposed = false
  /**
   * Bumped by every anchor sync. `play()` is async, so a status flip that
   * lands mid-await must be able to strand the older intent — otherwise a fast
   * pause-then-play settles on whichever promise happened to resolve last.
   */
  let anchorGeneration = 0

  let lastPublishedPosition = 0
  let lastPublishedAtMs = now()

  function publishPosition(): void {
    // With nothing loaded, leave the last position standing. Clearing it does
    // not give the OS "no position" — it gives it the anchor's own ten seconds.
    // Same reasoning as the metadata watcher below.
    if (!state.nowPlaying.value) return
    surface.setPositionState(toPositionState(state.duration.value, state.currentTime.value))
    lastPublishedPosition = state.currentTime.value
    lastPublishedAtMs = now()
  }

  function syncAnchor(playbackState: MediaSessionPlaybackState): void {
    const generation = ++anchorGeneration

    if (playbackState === 'none') {
      // Paused, deliberately *not* released — which is the opposite of what
      // W3-10 specified, because the specified version does not work.
      //
      // Chromium's Linux backend never withdraws an MPRIS bus name once it has
      // one, and it reports the last player state it *observed*. Releasing the
      // element therefore does not remove the OS card; it freezes it, and the
      // renderer has no way to know when the observation landed. Measured on
      // Electron 43: released while playing, MPRIS was stuck advertising
      // `PlaybackStatus = Playing` under the document title for the rest of the
      // process's life — a phantom card no later transport action could clear.
      //
      // Paused and left alone, Chromium sees the pause and the card settles to
      // a paused player carrying no metadata, which is as close to "nothing is
      // playing" as the platform allows. A paused element holds no audio focus,
      // so the cost is one dormant object. `dispose()` releases it for real.
      anchor?.pause()
      return
    }

    anchor ??= platform.createAnchor()
    if (playbackState !== 'playing') {
      anchor.pause()
      return
    }

    void anchor.play().catch((error: unknown) => {
      if (generation !== anchorGeneration || disposed) return
      // The cold-start case: a media key pressed before any click in the
      // window, against an autoplay policy that wants a gesture. Degrading to
      // a logged fault beats an unhandled rejection.
      console.warn('[media-session] silent anchor refused to play:', error)
    })
  }

  function applyStatus(): void {
    const playbackState = toPlaybackState(state.status.value, state.nowPlaying.value !== null)
    surface.setPlaybackState(playbackState)
    syncAnchor(playbackState)
    publishPosition()
  }

  /** Fire-and-forget for handlers the OS calls synchronously. */
  function run(action: () => Promise<void>, name: string): void {
    void action().catch((error: unknown) => {
      console.warn(`[media-session] ${name} from the OS failed:`, error)
    })
  }

  const handlers: {
    [K in MediaSessionActionName]: (details: MediaSessionActionDetails) => void
  } = {
    play: () => run(() => transport.resume(), 'play'),
    pause: () => transport.pause(),
    stop: () => transport.stop(),
    nexttrack: () => run(() => transport.next(), 'nexttrack'),
    previoustrack: () => run(() => transport.previous(), 'previoustrack'),
    seekbackward: (details) => {
      transport.seek(state.currentTime.value - (details.seekOffset ?? DEFAULT_SEEK_OFFSET_SEC))
    },
    seekforward: (details) => {
      transport.seek(state.currentTime.value + (details.seekOffset ?? DEFAULT_SEEK_OFFSET_SEC))
    },
    seekto: (details) => {
      if (typeof details.seekTime === 'number') transport.seek(details.seekTime)
    }
  }

  // Every action we intend to honour is registered. An unregistered action
  // falls through to Chromium's default handling, which would act on the anchor
  // element — pausing silence and leaving the OS state disagreeing with ours.
  for (const action of MEDIA_SESSION_ACTIONS) surface.setActionHandler(action, handlers[action])

  const stops = [
    watch(
      state.nowPlaying,
      (track) => {
        // Stopping freezes the card on the last track rather than blanking it.
        // Chromium will not withdraw the session (see `syncAnchor`), so clearing
        // the metadata does not remove the OS card — it replaces a real track
        // with the document title and the silent anchor's ten-second duration,
        // which reads as a bug. Every other player leaves the last track showing
        // when stopped. `dispose()` is the one place that really clears it.
        if (track) surface.setMetadata(toMediaMetadata(track))
      },
      { immediate: true }
    ),
    watch(state.duration, publishPosition),
    watch(state.status, applyStatus, { immediate: true }),
    watch(state.currentTime, (current) => {
      // A drag writes `currentTime` on every pointer move; each write looks
      // like a jump and none of them is committed yet.
      if (state.scrubbing.value) return
      const drift = Math.abs(current - lastPublishedPosition - (now() - lastPublishedAtMs) / 1000)
      if (drift > SEEK_DISCONTINUITY_SEC) publishPosition()
    })
  ]

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const stop of stops) stop()
      for (const action of MEDIA_SESSION_ACTIONS) surface.setActionHandler(action, null)
      surface.setPlaybackState('none')
      surface.setMetadata(null)
      surface.setPositionState(null)
      anchor?.dispose()
      anchor = null
    },
    hasAnchor: (): boolean => anchor !== null
  }
}
