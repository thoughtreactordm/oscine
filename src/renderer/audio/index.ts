/**
 * The audio module's public face. UI code imports from here and nowhere deeper.
 *
 * ## How the M2 replacement lands
 *
 * R1 says this pipeline has a memory ceiling, and M2 is the milestone that
 * measures whether it bites. If it does, a WebCodecs implementation arrives as:
 *
 * 1. A new `WebCodecsAudioEngine implements AudioEngine`, beside
 *    `DecodedAudioEngine`.
 * 2. One changed line in `createAudioEngine` below — or a condition on decoded
 *    size, keeping `DecodedAudioEngine` for short tracks where whole-buffer
 *    decode gives sample-accurate gapless for free and streaming would not.
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
  PlaybackPosition,
  PlaybackStatus
} from './AudioEngine'
export { AudioEngineError, AUDIO_ERROR_CODES } from './AudioEngine'
export { estimateDecodedBytes } from './decodedSize'

import type { AudioEngine } from './AudioEngine'
import { DecodedAudioEngine } from './DecodedAudioEngine'

/**
 * Build the engine. The only supported way to get one.
 *
 * Constructing an `AudioContext` grabs an audio device, so callers should hold
 * a single engine for the app's lifetime and `dispose()` it on teardown rather
 * than making one per view.
 */
export function createAudioEngine(): AudioEngine {
  return new DecodedAudioEngine()
}
