import type { StreamingMedia, StreamingPlatform } from './StreamingAudioEngine'

const VOLUME_RAMP_SEC = 0.015

/** Builds the real `<audio>` → MediaElementSource → GainNode browser graph. */
export function createBrowserStreamingPlatform(): StreamingPlatform {
  const element = new Audio()
  element.preload = 'metadata'
  // The renderer origin and fermata: are distinct in development. The custom
  // protocol is CORS-enabled, so request an origin-clean media source.
  element.crossOrigin = 'anonymous'

  const context = new AudioContext()
  const gain = context.createGain()
  const source = context.createMediaElementSource(element)
  source.connect(gain)
  gain.connect(context.destination)

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
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(value, now + VOLUME_RAMP_SEC)
    },
    dispose() {
      element.pause()
      element.removeAttribute('src')
      element.load()
      source.disconnect()
      gain.disconnect()
      void context.close()
    }
  }
}
