/**
 * The audio settings the transport has to keep pushing at the engine.
 *
 * Sibling of `transportPreferences.ts` and the same idea: names the keys once,
 * and hands the controller bindings rather than values. The distinction matters
 * for the reason W8-4 exists — a controller that read these at construction
 * would be one where changing the pre-amp did nothing until relaunch, and every
 * one of these has to land under a track that is already playing.
 *
 * Durable rather than view-scoped, unlike shuffle and repeat: how loud a library
 * plays and how much memory it may decode into are properties of the library and
 * the machine, not of a window. `audio.outputDevice` is durable too, and W8-13
 * excludes it from the export bundle by key rather than by scope, because a
 * second window on this machine must not end up on a different device.
 *
 * `boundaryPolicy` is not bound here. The crossfade is already bound in the
 * controller, through the cascade, because it resolves at the playing playlist
 * rather than globally — see `bindCrossfadeMs`.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  AUDIO_DECODE_RESIDENCY_BUDGET_MB,
  AUDIO_DECODE_TRACK_CAP_MB,
  AUDIO_OUTPUT_DEVICE,
  AUDIO_PREFETCH_DEPTH,
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB,
  MIB
} from '@shared/settings'
import {
  DEFAULT_NORMALIZATION_POLICY,
  type NormalizationMode,
  type NormalizationPolicy
} from '../audio/normalization'
import type { R1Policy } from '../audio/r1Admission'
import type { SettingsReader } from '../settings/reader'

export interface AudioPreferenceBinding {
  /**
   * `audio.replayGainMode`, writable, because the transport can set it.
   *
   * The other two ReplayGain keys have no transport control and are read-only
   * here — the settings view writes them. Assigning to this one persists it, so
   * the controller has no mode of its own to keep in step.
   */
  mode: Ref<NormalizationMode>
  /**
   * The three ReplayGain keys as the one value the engine takes.
   *
   * Computed rather than three refs the controller reassembles, so that the
   * scheduler's `sameNormalizationPolicy` check sees one change when the mode
   * moves rather than one per key, and so there is a single place where "what
   * are the loudness settings" is answered.
   */
  normalization: ComputedRef<NormalizationPolicy>
  /** R1's budgets in bytes. `resolveR1Policy` clamps them again downstream. */
  decodePolicy: ComputedRef<R1Policy>
  prefetchDepth: ComputedRef<number>
  /** Writable: the settings control assigns to it. `''` is the system default. */
  outputDevice: Ref<string>
}

/**
 * Bind to a settings surface, or to the registry defaults.
 *
 * Omitting the store is supported for exactly the reason `bindTransportPreferences`
 * supports it: a test that does not care about persistence gets working defaults
 * rather than a required dependency. The defaults are the descriptors', which is
 * the whole of W8-9's rule — there is no second copy of them in this file.
 */
export function bindAudioPreferences(settings?: SettingsReader): AudioPreferenceBinding {
  if (!settings) {
    const mode = ref<NormalizationMode>(DEFAULT_NORMALIZATION_POLICY.mode)
    return {
      mode,
      normalization: computed(() => ({ ...DEFAULT_NORMALIZATION_POLICY, mode: mode.value })),
      decodePolicy: computed(() => defaultDecodePolicy()),
      prefetchDepth: computed(() => AUDIO_PREFETCH_DEPTH.default),
      outputDevice: ref(AUDIO_OUTPUT_DEVICE.default)
    }
  }

  const mode = settings.value<NormalizationMode>(AUDIO_REPLAY_GAIN_MODE.key)
  return {
    mode,
    normalization: computed(() => ({
      mode: mode.value,
      preampDb: settings.get<number>(AUDIO_REPLAY_GAIN_PREAMP_DB.key),
      fallbackGainDb: settings.get<number>(AUDIO_REPLAY_GAIN_FALLBACK_DB.key)
    })),
    decodePolicy: computed(() => ({
      maxTrackDecodedBytes: settings.get<number>(AUDIO_DECODE_TRACK_CAP_MB.key) * MIB,
      maxDecodedResidencyBytes: settings.get<number>(AUDIO_DECODE_RESIDENCY_BUDGET_MB.key) * MIB
    })),
    prefetchDepth: computed(() => settings.get<number>(AUDIO_PREFETCH_DEPTH.key)),
    outputDevice: settings.value<string>(AUDIO_OUTPUT_DEVICE.key)
  }
}

function defaultDecodePolicy(): R1Policy {
  return {
    maxTrackDecodedBytes: AUDIO_DECODE_TRACK_CAP_MB.default * MIB,
    maxDecodedResidencyBytes: AUDIO_DECODE_RESIDENCY_BUDGET_MB.default * MIB
  }
}
