import {
  createMediaSessionSurface,
  type MediaArtworkDescriptor,
  type MediaSessionAnchor,
  type MediaSessionPlatform
} from './mediaSession'

/**
 * The real `navigator.mediaSession` and the real silent anchor element.
 *
 * Every DOM type the OS integration needs is confined here, exactly as
 * `browserStreamingPlatform.ts` confines the streaming graph's. `mediaSession.ts`
 * holds the rules and is testable under plain Node; this file is the part that
 * can only be verified by running the application.
 */

/** Ten seconds of silence, 8 kHz mono. Long enough to be treated as media. */
const ANCHOR_SECONDS = 10
const ANCHOR_SAMPLE_RATE = 8000

/**
 * Unsigned 8-bit PCM puts zero amplitude at the midpoint of the range, so
 * silence is 0x80. A zero-filled buffer is not quiet — it is the negative rail
 * held flat, which is a click on start and a DC offset thereafter.
 */
const PCM8_SILENCE = 0x80

/**
 * Builds a silent looping WAV.
 *
 * Three constraints on this element are load-bearing and none of them is
 * obvious, so they are recorded rather than left to be rediscovered:
 *
 * - It must carry a real audio track. An empty `src` opens no session.
 * - It must not be `muted` and must have `volume > 0`. Chromium's
 *   effective-volume test is how it decides a player wants audio focus, and a
 *   muted element is ignored outright.
 * - Its duration must clear Chromium's significant-playback threshold (about
 *   five seconds). Shorter media is classed as a sound effect, which opens no
 *   session either — hence ten seconds on a loop rather than a short blip.
 *
 * Built as a blob rather than a base64 data URL: the same bytes without the
 * third they would gain from base64, and without an 80 kB literal in the
 * bundle. It is a plain `ArrayBuffer` outside the audio graph, so it never
 * reaches `DecodedBufferLedger` and never appears in the `[audio] R1`
 * diagnostics that three closed cards rest on.
 */
function createSilentWavUrl(): string {
  const dataBytes = ANCHOR_SECONDS * ANCHOR_SAMPLE_RATE
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, ANCHOR_SAMPLE_RATE, true)
  view.setUint32(28, ANCHOR_SAMPLE_RATE, true) // byte rate: 1 channel * 8 bit
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  new Uint8Array(buffer, 44).fill(PCM8_SILENCE)

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

function createAnchor(): MediaSessionAnchor {
  const url = createSilentWavUrl()
  const element = new Audio(url)
  element.loop = true
  element.preload = 'auto'
  // Not `muted`, and not zero — see the note on `createSilentWavUrl`.
  element.volume = 1
  // Never attached to the document. It is a player, not a view, and the
  // streaming engine's element is off-DOM for the same reason.

  let wantsToPlay = false

  /**
   * `loop` should make this unreachable, but a session that ends mid-track is
   * a card that vanishes while music is still playing — cheap to make robust.
   */
  const onEnded = (): void => {
    if (!wantsToPlay) return
    element.currentTime = 0
    void element.play().catch(() => {})
  }
  element.addEventListener('ended', onEnded)

  return {
    play(): Promise<void> {
      wantsToPlay = true
      return element.play()
    },
    pause(): void {
      wantsToPlay = false
      element.pause()
    },
    // Only ever reached when the controller is being torn down, so the OS
    // state it leaves behind outlives nothing. The binding pauses rather than
    // releases when playback merely stops — see `syncAnchor`.
    dispose(): void {
      wantsToPlay = false
      element.removeEventListener('ended', onEnded)
      element.pause()
      element.removeAttribute('src')
      element.load()
      URL.revokeObjectURL(url)
    }
  }
}

/**
 * Reads one artwork route and re-addresses it as a blob URL.
 *
 * The reason Chromium needs this, and the probe that established it, are on
 * `createMediaSessionSurface`. Only `MediaImage` refuses the `oscine://`
 * scheme — `fetch` reaches it fine, which is what makes the re-address cheap.
 */
async function loadArtwork(image: MediaArtworkDescriptor): Promise<MediaArtworkDescriptor | null> {
  try {
    const response = await fetch(image.src)
    if (!response.ok) return null
    const blob = await response.blob()
    return { ...image, src: URL.createObjectURL(blob), type: blob.type || image.type }
  } catch {
    // A cover that will not load is not a reason to lose the OS card.
    return null
  }
}

/**
 * The platform, or `null` where there is no Media Session API to talk to —
 * which is every test environment, and any renderer running outside Electron.
 */
export function createBrowserMediaSessionPlatform(): MediaSessionPlatform | null {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return null
  const surface = createMediaSessionSurface({
    session: navigator.mediaSession,
    createMetadata: (init) => new MediaMetadata(init),
    loadArtwork,
    releaseArtwork: (url) => URL.revokeObjectURL(url)
  })
  return { surface, createAnchor }
}
