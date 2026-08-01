/**
 * The audio module's public face. UI code imports from here and nowhere deeper.
 *
 * ## M2's two-path implementation
 *
 * R1 says whole-buffer decode needs a memory ceiling. `GuardedAudioEngine`
 * prices each track before bytes are fetched, retains `DecodedAudioEngine` for
 * admitted tracks, and selects an HTML media-element path for everything else.
 *
 * Nothing else moves. No UI file names a Web Audio type, an `AudioBuffer`, or
 * either class: they hold an `AudioEngine` handed to them by this factory, and
 * every quantity crossing that interface is a number. That is the whole reason
 * the interface was written before the implementation.
 */

export type {
  AudioEngine,
  AudioEngineEventMap,
  AudioErrorCode,
  AudioTransitionPolicy,
  NormalizationMode,
  PlaybackPosition,
  PlaybackStatus
} from './AudioEngine'
export { AudioEngineError, AUDIO_ERROR_CODES } from './AudioEngine'
export {
  DEFAULT_NORMALIZATION_POLICY,
  NORMALIZATION_MODES,
  dbToLinear,
  normalizationPolicyForMode,
  resolveNormalization,
  sameNormalizationPolicy,
  type NormalizationDecision,
  type NormalizationPolicy
} from './normalization'
export { estimateDecodedBytes, estimateDecodePeakBytes } from './decodedSize'
export {
  AudioOutputRouter,
  SYSTEM_DEFAULT_OUTPUT_DEVICE,
  type SinkCapableContext
} from './outputDevice'
export {
  DEFAULT_R1_POLICY,
  R1_POLICY_LIMITS,
  decideR1Admission,
  resolveR1Policy,
  R1ReservationLedger,
  type R1AdmissionDecision,
  type R1Policy
} from './r1Admission'

import { library, podcasts } from '@renderer/ipc'
import { episodeIdFromPlaybackTrackId } from '@shared/podcasts'
import type { AudioEngine } from './AudioEngine'
import { DecodedAudioEngine } from './DecodedAudioEngine'
import { DecodedAudioContextPool } from './decodedAudioContext'
import { DecodedBufferLedger } from './decodedBufferLedger'
import { GuardedAudioEngine } from './GuardedAudioEngine'
import { StreamingAudioEngine } from './StreamingAudioEngine'
import { createBrowserStreamingPlatform } from './browserStreamingPlatform'
import { AudioOutputRouter } from './outputDevice'
import type { R1Policy } from './r1Admission'
import { R1ReservationLedger } from './r1Admission'

/**
 * Build the engine. The only supported way to get one.
 *
 * Constructing an `AudioContext` grabs an audio device, so callers should hold
 * a single engine for the app's lifetime and `dispose()` it on teardown rather
 * than making one per view.
 */
export function createAudioEngine(policy: Partial<R1Policy> = {}): AudioEngine {
  return createAudioEngineFactory(policy).createEngine()
}

/**
 * Everything one audio device's worth of engines shares.
 *
 * `createEngine` is what it always was. The output device sits beside it rather
 * than on `AudioEngine` because it is a fact about the contexts the factory
 * builds, not about a slot — see `outputDevice.ts`.
 */
export interface AudioEngineFactory {
  createEngine: () => AudioEngine
  /** `''` selects the system default. Live; no restart, no reload. */
  setOutputDevice: (deviceId: string) => Promise<void>
  readonly outputDeviceId: string
  /** False when this runtime's `AudioContext` has no `setSinkId`. */
  readonly outputDeviceSelectable: boolean
}

/**
 * Build engines which account decoded memory in one proven-freed ledger.
 *
 * The playback scheduler owns two engines (current and prefetched-next). A
 * ledger per engine would let both independently admit almost the full R1
 * budget, defeating the current+prefetch ceiling precisely when it matters.
 *
 * `policy` is an override, not a default: omitting it means R1's registry
 * defaults, and the controller supplies the operator's values from
 * `audio.decodeTrackCapMb` and `audio.decodeResidencyBudgetMb`. `resolveR1Policy`
 * clamps whatever arrives, so this boundary cannot be used to raise the guard's
 * ceiling.
 */
export function createAudioEngineFactory(policy: Partial<R1Policy> = {}): AudioEngineFactory {
  const decodedBuffers = new DecodedBufferLedger()
  const router = new AudioOutputRouter()
  const decodedContext = new DecodedAudioContextPool(() => router.adopt(new AudioContext()))
  const reservations = new R1ReservationLedger()

  const createEngine = (): AudioEngine =>
    new GuardedAudioEngine({
      decoded: new DecodedAudioEngine(decodedBuffers, decodedContext.acquire()),
      createStreaming: () =>
        new StreamingAudioEngine(
          createBrowserStreamingPlatform({ adoptContext: (context) => router.adopt(context) })
        ),
      policy,
      reservations,
      resolveTrack: async (trackId) => {
        // Negative ids are downloaded podcast episodes — see
        // `episodePlaybackTrackId`. Positive ids stay library tracks.
        const episodeId = episodeIdFromPlaybackTrackId(trackId)
        if (episodeId !== null) {
          const metadata = await podcasts.getEpisodeAudioMetadata(episodeId)
          const url = await podcasts.getEpisodeFileUrl(episodeId)
          return {
            trackId,
            url,
            durationSec: metadata.durationSec,
            encodedBytes: metadata.encodedBytes,
            channels: metadata.channels,
            rgTrackGainDb: null,
            rgTrackPeak: null,
            rgAlbumGainDb: null,
            rgAlbumPeak: null,
            rgSource: null
          }
        }

        // Both calls are metadata/control-plane IPC. No response body containing
        // track bytes is requested until the selected path begins its own load.
        const metadata = await library.getTrackAudioMetadata(trackId)
        const url = await library.getTrackFileUrl(trackId)
        return { trackId, url, ...metadata }
      }
    })

  return {
    createEngine,
    setOutputDevice: (deviceId) => router.setDevice(deviceId),
    get outputDeviceId() {
      return router.deviceId
    },
    get outputDeviceSelectable() {
      return router.supported
    }
  }
}
