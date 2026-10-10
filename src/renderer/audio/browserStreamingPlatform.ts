import { WAVEFORM_SAMPLE_COUNT } from './AudioEngine'
import type { DecodedAudioContextLease } from './decodedAudioContext'
import type { StreamingMedia, StreamingPlatform } from './StreamingAudioEngine'

const VOLUME_RAMP_SEC = 0.015
const NORMALIZATION_RAMP_SEC = 0.05

/**
 * Builds the real media graph:
 * `<audio>` → normalization → master volume → lease destination,
 * with a waveform analyser hung off normalization as a sink.
 *
 * The context is leased from the same pool the decoded slots use, never built
 * here. Every `AudioContext` opens its own output stream, and the OS mixer lists
 * each one as a separate "oscine" volume control. A context per streaming
 * platform left one such control per scheduler slot that had ever streamed a
 * long track, all idle, all indistinguishable from the one carrying sound. One
 * context means one stream, and the lease's destination is the EQ chain input
 * the pool already built on it, with the sink already adopted by the router.
 */
export function createBrowserStreamingPlatform(
  lease: DecodedAudioContextLease<AudioContext>
): StreamingPlatform {
  const element = new Audio()
  element.preload = 'metadata'
  // The renderer origin and oscine: are distinct in development. The custom
  // protocol is CORS-enabled, so request an origin-clean media source.
  element.crossOrigin = 'anonymous'

  const { context } = lease
  const normalizationGain = context.createGain()
  const masterGain = context.createGain()
  const analyser = context.createAnalyser()
  analyser.fftSize = WAVEFORM_SAMPLE_COUNT
  const source = context.createMediaElementSource(element)
  source.connect(normalizationGain)
  normalizationGain.connect(masterGain)
  masterGain.connect(lease.destination)
  // Ahead of master volume, matching the decoded path so the visualization does
  // not change shape when R1 sends a long track down this one.
  normalizationGain.connect(analyser)

  const media: StreamingMedia = {
    get currentTime() {
      return element.currentTime
    },
    set currentTime(seconds: number) {
      element.currentTime = seconds
    },
    get duration() {
      return element.duration
    },
    get ended() {
      return element.ended
    },
    get readyState() {
      return element.readyState
    },
    get errorCode() {
      return element.error?.code ?? null
    },
    setSource(url) {
      element.src = url
    },
    clearSource() {
      element.removeAttribute('src')
      element.load()
    },
    load() {
      element.load()
    },
    play: () => element.play(),
    pause: () => element.pause(),
    on(type, listener) {
      element.addEventListener(type, listener)
      return () => element.removeEventListener(type, listener)
    }
  }

  return {
    media,
    get contextState() {
      return context.state
    },
    resumeContext: () => context.resume(),
    setOutputVolume(value) {
      const now = context.currentTime
      masterGain.gain.cancelScheduledValues(now)
      masterGain.gain.setValueAtTime(masterGain.gain.value, now)
      masterGain.gain.linearRampToValueAtTime(value, now + VOLUME_RAMP_SEC)
    },
    setNormalizationGain(value, ramp) {
      const now = context.currentTime
      normalizationGain.gain.cancelScheduledValues(now)
      if (!ramp) {
        normalizationGain.gain.setValueAtTime(value, now)
        return
      }
      normalizationGain.gain.setValueAtTime(normalizationGain.gain.value, now)
      normalizationGain.gain.linearRampToValueAtTime(value, now + NORMALIZATION_RAMP_SEC)
    },
    readWaveform(into) {
      analyser.getFloatTimeDomainData(into)
      return true
    },
    dispose() {
      element.pause()
      element.removeAttribute('src')
      element.load()
      source.disconnect()
      normalizationGain.disconnect()
      masterGain.disconnect()
      analyser.disconnect()
      // Shared with the decoded slots, so not ours to close. The pool closes it
      // when its last lease goes.
      lease.release()
    }
  }
}
