import { WAVEFORM_SAMPLE_COUNT } from './AudioEngine'
import type { StreamingMedia, StreamingPlatform } from './StreamingAudioEngine'

const VOLUME_RAMP_SEC = 0.015
const NORMALIZATION_RAMP_SEC = 0.05

export interface BrowserStreamingPlatformOptions {
  /**
   * Hands the freshly built context to `AudioOutputRouter` so it lands on the
   * selected output device.
   *
   * A hook rather than a `setOutputDevice` method on `StreamingPlatform`,
   * because the element is captured by `createMediaElementSource` and so the
   * sink is the context's, not the element's — a per-platform setter would be a
   * second place to hold the same one desired device. Optional: a platform built
   * without it plays to the system default, which is what the tests want.
   */
  adoptContext?: (context: AudioContext) => void
}

/**
 * Builds the real media graph:
 * `<audio>` → normalization → master volume → destination,
 * with a waveform analyser hung off normalization as a sink.
 */
export function createBrowserStreamingPlatform(
  options: BrowserStreamingPlatformOptions = {}
): StreamingPlatform {
  const element = new Audio()
  element.preload = 'metadata'
  // The renderer origin and fermata: are distinct in development. The custom
  // protocol is CORS-enabled, so request an origin-clean media source.
  element.crossOrigin = 'anonymous'

  const context = new AudioContext()
  options.adoptContext?.(context)
  const normalizationGain = context.createGain()
  const masterGain = context.createGain()
  const analyser = context.createAnalyser()
  analyser.fftSize = WAVEFORM_SAMPLE_COUNT
  const source = context.createMediaElementSource(element)
  source.connect(normalizationGain)
  normalizationGain.connect(masterGain)
  masterGain.connect(context.destination)
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
      void context.close()
    }
  }
}
