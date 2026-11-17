import { WAVEFORM_SAMPLE_COUNT, type WaveformBuffer } from '../audio/AudioEngine'

/**
 * The stage's side of the stereo tap — **W23-14, D35.10**.
 *
 * The engine builds its splitter and analysers only while somebody holds a
 * subscription (W23-13), so the host must hold one exactly while a
 * `needs.stereo` effect is the instantiated one and drop it the moment that
 * effect is disposed. This is that bookkeeping, kept out of the Vue component
 * so it can be tested: the host calls {@link StereoFeed.sync} with the effect it
 * has just created (or null when it disposes one) and {@link StereoFeed.read}
 * once a frame.
 *
 * Pure, `@renderer`-free and DOM-free. The buffers are allocated once here and
 * refilled in place; nothing is allocated per frame.
 */

/**
 * The playback surface's optional stereo pair. They come together or not at
 * all (`AudioEngine.subscribeStereoWaveform`); a surface with only one of them
 * counts as having neither.
 */
export interface StereoSource {
  subscribeStereoWaveform?(): () => void
  readStereoWaveform?(left: WaveformBuffer, right: WaveformBuffer): boolean
}

/** What a `needs.stereo` effect gets in `StageInputs.stereo`. */
export interface StereoInput {
  /** `WAVEFORM_SAMPLE_COUNT` samples per channel, −1..1, before master volume. */
  readonly left: Float32Array
  readonly right: Float32Array
  /**
   * False when this frame's read answered nothing (nothing audible): the
   * buffers then still hold an older read and should not be drawn as current.
   */
  readonly live: boolean
}

/** The slice of `VisualizerEffect` the feed reads. */
interface StereoNeeds {
  readonly id: string
  readonly needs?: { readonly cover?: boolean; readonly stereo?: boolean }
}

/** Whether `source` carries the stereo pair; effects that need it are not offered otherwise. */
export function stereoSupported(source: StereoSource | null | undefined): boolean {
  return (
    !!source &&
    typeof source.subscribeStereoWaveform === 'function' &&
    typeof source.readStereoWaveform === 'function'
  )
}

/**
 * `effects` less those that declare `needs.stereo` when the engine has no
 * stereo tap. The same array when nothing is removed.
 */
export function withStereoSupport<E extends StereoNeeds>(
  effects: readonly E[],
  supported: boolean
): readonly E[] {
  if (supported || !effects.some((effect) => effect.needs?.stereo)) return effects
  return effects.filter((effect) => !effect.needs?.stereo)
}

export interface StereoFeed {
  /** True while a subscription is held. */
  readonly subscribed: boolean
  /**
   * The effect now instantiated, or null when there is none. Subscribes when
   * it needs stereo and the source has the pair; releases otherwise.
   */
  sync(effect: StereoNeeds | null): void
  /** This frame's samples; null while nothing is subscribed. */
  read(): StereoInput | null
  /** Release whatever is held. The feed may be synced again after. */
  dispose(): void
}

export function createStereoFeed(source: StereoSource): StereoFeed {
  const left: WaveformBuffer = new Float32Array(WAVEFORM_SAMPLE_COUNT)
  const right: WaveformBuffer = new Float32Array(WAVEFORM_SAMPLE_COUNT)
  const input: { left: Float32Array; right: Float32Array; live: boolean } = {
    left,
    right,
    live: false
  }
  let release: (() => void) | null = null

  function drop(): void {
    const held = release
    release = null
    input.live = false
    held?.()
  }

  return {
    get subscribed() {
      return release !== null
    },

    sync(effect) {
      const wants = !!effect?.needs?.stereo && stereoSupported(source)
      if (wants && !release) {
        left.fill(0)
        right.fill(0)
        input.live = false
        // The tap is the engine's, and a throw from it must not take the
        // host's frame loop down with it: the effect draws nothing instead.
        try {
          release = source.subscribeStereoWaveform!()
        } catch (error) {
          release = null
          console.warn('[visualizer] the stereo tap could not be opened', error)
        }
      } else if (!wants) {
        drop()
      }
    },

    read() {
      if (!release) return null
      try {
        input.live = source.readStereoWaveform!(left, right)
      } catch {
        input.live = false
      }
      return input
    },

    dispose: drop
  }
}
