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
  PlaybackPosition,
  PlaybackStatus
} from './AudioEngine'
export { AudioEngineError, AUDIO_ERROR_CODES } from './AudioEngine'
export { estimateDecodedBytes, estimateDecodePeakBytes } from './decodedSize'
export {
  DEFAULT_R1_POLICY,
  decideR1Admission,
  type R1AdmissionDecision,
  type R1Policy
} from './r1Admission'

import { library } from '@renderer/ipc'
import type { AudioEngine } from './AudioEngine'
import { DecodedAudioEngine } from './DecodedAudioEngine'
import { GuardedAudioEngine } from './GuardedAudioEngine'
import { StreamingAudioEngine } from './StreamingAudioEngine'
import { createBrowserStreamingPlatform } from './browserStreamingPlatform'
import type { R1Policy } from './r1Admission'

/**
 * Build the engine. The only supported way to get one.
 *
 * Constructing an `AudioContext` grabs an audio device, so callers should hold
 * a single engine for the app's lifetime and `dispose()` it on teardown rather
 * than making one per view.
 */
export function createAudioEngine(policy: Partial<R1Policy> = {}): AudioEngine {
  return new GuardedAudioEngine({
    decoded: new DecodedAudioEngine(),
    createStreaming: () => new StreamingAudioEngine(createBrowserStreamingPlatform()),
    policy,
    resolveTrack: async (trackId) => {
      // Both calls are metadata/control-plane IPC. No response body containing
      // track bytes is requested until the selected path begins its own load.
      const metadata = await library.getTrackAudioMetadata(trackId)
      const url = await library.getTrackFileUrl(trackId)
      return { trackId, url, ...metadata }
    }
  })
}
