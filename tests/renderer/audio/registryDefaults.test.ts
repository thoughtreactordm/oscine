import { describe, expect, it } from 'vitest'
import {
  AUDIO_DECODE_RESIDENCY_BUDGET_MB,
  AUDIO_DECODE_TRACK_CAP_MB,
  AUDIO_PREFETCH_DEPTH,
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB,
  MIB
} from '../../../src/shared/settings'
import {
  DEFAULT_NORMALIZATION_POLICY,
  normalizationPolicyForMode
} from '../../../src/renderer/audio/normalization'
import { DEFAULT_R1_POLICY, R1_POLICY_LIMITS } from '../../../src/renderer/audio/r1Admission'
import { PlaybackScheduler } from '../../../src/renderer/playback/scheduler'

/**
 * W8-9's third "done when": no audio default remains hardcoded outside the
 * registry.
 *
 * The two module-scope policy objects are the ones that could drift, because a
 * pure function on the hot path needs a value rather than a store and so cannot
 * simply read one. They are derived from the descriptors, and these assertions
 * are what keeps them derived — the failure mode this replaces is real and
 * recent: `DEFAULT_NORMALIZATION_MODE` said `track` while
 * `audio.replayGainMode` said `album`, and the renderer's copy was the one
 * playback used, so the settings view advertised a default the app did not have.
 */
describe('audio defaults come from the registry', () => {
  it('takes R1 budgets from the two decode descriptors', () => {
    expect(DEFAULT_R1_POLICY).toEqual({
      maxTrackDecodedBytes: AUDIO_DECODE_TRACK_CAP_MB.default * MIB,
      maxDecodedResidencyBytes: AUDIO_DECODE_RESIDENCY_BUDGET_MB.default * MIB
    })
  })

  it('takes the guard bounds from the same descriptors', () => {
    expect(R1_POLICY_LIMITS.maxTrackDecodedBytes.max / MIB).toBe(1024)
    expect(R1_POLICY_LIMITS.maxDecodedResidencyBytes.max / MIB).toBe(2048)
  })

  it('takes the loudness policy from the three ReplayGain descriptors', () => {
    expect(DEFAULT_NORMALIZATION_POLICY).toEqual({
      mode: AUDIO_REPLAY_GAIN_MODE.default,
      preampDb: AUDIO_REPLAY_GAIN_PREAMP_DB.default,
      fallbackGainDb: AUDIO_REPLAY_GAIN_FALLBACK_DB.default
    })
  })

  it('builds a mode-only policy from that same default', () => {
    expect(normalizationPolicyForMode('album')).toEqual({
      ...DEFAULT_NORMALIZATION_POLICY,
      mode: 'album'
    })
  })

  it('takes the scheduler decode-ahead default from its descriptor', () => {
    const scheduler = new PlaybackScheduler({
      createEngine: () => {
        throw new Error('no engine is created before the first play')
      }
    })

    expect(scheduler.prefetchDepth).toBe(AUDIO_PREFETCH_DEPTH.default)
    scheduler.dispose()
  })
})
