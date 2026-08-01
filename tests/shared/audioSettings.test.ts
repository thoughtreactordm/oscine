import { describe, expect, it } from 'vitest'
import {
  AUDIO_CROSSFADE_MS,
  AUDIO_DECODE_RESIDENCY_BUDGET_MB,
  AUDIO_DECODE_TRACK_CAP_MB,
  AUDIO_NUMERIC_BOUNDS,
  AUDIO_OUTPUT_DEVICE,
  AUDIO_PREFETCH_DEPTH,
  AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING,
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB,
  auditRegistry,
  boundaryPolicy,
  clampSetting,
  GLOBAL_SCOPE,
  getSetting,
  resolveCascade,
  settingsInCategory,
  type CascadeLayer,
  type StoredSetting
} from '@shared/settings'

const PLAYLIST = { kind: 'playlist', id: 7 } as const

type CrossfadeCascade = typeof AUDIO_CROSSFADE_MS.cascade

function row(value: unknown, version = 1): StoredSetting {
  return { value, version }
}

function layers(
  entity: StoredSetting | null,
  global: StoredSetting | null
): CascadeLayer<CrossfadeCascade>[] {
  return [
    { scope: PLAYLIST, stored: entity },
    { scope: GLOBAL_SCOPE, stored: global }
  ]
}

/** What the scheduler asks: gapless, or a crossfade of exactly this many ms. */
function policyAt(entity: StoredSetting | null, global: StoredSetting | null) {
  return boundaryPolicy(resolveCascade(AUDIO_CROSSFADE_MS, layers(entity, global)).value)
}

/**
 * W8-9's first "done when", and the reason the card exists rather than being data
 * entry: the gapless/crossfade exclusivity has to hold at every cascade level,
 * not only at the global.
 *
 * It is tested through `boundaryPolicy` over `resolveCascade` rather than
 * through a validated pair of keys, because that is how the invariant is
 * actually enforced — one number per boundary, two states, no representable
 * third. What these assertions are proving is that the derivation is total: at
 * every level, and across a change to one level while another holds a row, the
 * answer is exactly one of gapless and crossfade.
 */
describe('the gapless/crossfade exclusivity', () => {
  it('is exclusive for every value the descriptor will accept', () => {
    for (const milliseconds of [0, 1, 250, 3000, 12_000]) {
      const policy = boundaryPolicy(milliseconds)
      expect(policy.mode === 'gapless').toBe(policy.crossfadeMs === 0)
      expect(policy.mode === 'crossfade').toBe(policy.crossfadeMs > 0)
    }
  })

  it('normalizes a value no descriptor would have produced', () => {
    // A negative, a fraction and a non-number can all reach a boundary from a
    // store written by another build. None of them is a third state.
    expect(boundaryPolicy(-500)).toEqual({ mode: 'gapless', crossfadeMs: 0 })
    expect(boundaryPolicy(Number.NaN)).toEqual({ mode: 'gapless', crossfadeMs: 0 })
    expect(boundaryPolicy(750.6)).toEqual({ mode: 'crossfade', crossfadeMs: 750 })
  })

  describe('at the global level', () => {
    it('is gapless when nothing has been set', () => {
      expect(policyAt(null, null)).toEqual({ mode: 'gapless', crossfadeMs: 0 })
    })

    it('is a crossfade once the global says so', () => {
      expect(policyAt(null, row(2000))).toEqual({ mode: 'crossfade', crossfadeMs: 2000 })
    })

    it('is gapless again when the global is set back to zero', () => {
      expect(policyAt(null, row(0))).toEqual({ mode: 'gapless', crossfadeMs: 0 })
    })
  })

  describe('at the playlist-override level', () => {
    it('takes the override rather than the global', () => {
      expect(policyAt(row(500), row(2000))).toEqual({ mode: 'crossfade', crossfadeMs: 500 })
    })

    it('lets a playlist be gapless under a crossfading library', () => {
      // The concept record inside a library that crossfades everything else —
      // the case the whole cascade was built for.
      expect(policyAt(row(0), row(2000))).toEqual({ mode: 'gapless', crossfadeMs: 0 })
    })

    it('lets a playlist crossfade under a gapless library', () => {
      expect(policyAt(row(3000), row(0))).toEqual({ mode: 'crossfade', crossfadeMs: 3000 })
    })

    it('falls back to the global when the override is unreadable', () => {
      // A rejected row does not leave the boundary in neither state; it leaves
      // it in the state the level above says.
      expect(policyAt(row('loud'), row(2000))).toEqual({ mode: 'crossfade', crossfadeMs: 2000 })
    })
  })

  describe('across a change to the global while an override exists', () => {
    it('keeps the playlist gapless when the global moves', () => {
      const before = policyAt(row(0), row(2000))
      const after = policyAt(row(0), row(6000))

      expect(before).toEqual({ mode: 'gapless', crossfadeMs: 0 })
      expect(after).toEqual(before)
    })

    it('keeps the playlist crossfading when the global goes gapless', () => {
      expect(policyAt(row(500), row(2000))).toEqual({ mode: 'crossfade', crossfadeMs: 500 })
      expect(policyAt(row(500), row(0))).toEqual({ mode: 'crossfade', crossfadeMs: 500 })
    })

    it('hands the playlist the new global once its override is cleared', () => {
      expect(policyAt(row(500), row(2000))).toEqual({ mode: 'crossfade', crossfadeMs: 500 })
      expect(policyAt(null, row(2000))).toEqual({ mode: 'crossfade', crossfadeMs: 2000 })
      expect(policyAt(null, row(0))).toEqual({ mode: 'gapless', crossfadeMs: 0 })
    })
  })
})

/**
 * W8-9's second "done when": the clamps hold against operator input.
 *
 * The descriptor half is here; `resolveR1Policy` re-applies the same bounds and
 * is tested in `tests/renderer/audio/r1Admission.test.ts`, because that is the
 * one that has to hold when the value did not come through a descriptor at all.
 */
describe('the advanced audio bounds', () => {
  it('clamps a decode cap an operator tries to exceed', () => {
    const { min, max } = AUDIO_NUMERIC_BOUNDS.decodeTrackCapMb

    expect(clampSetting(AUDIO_DECODE_TRACK_CAP_MB, 100_000)).toBe(max)
    expect(clampSetting(AUDIO_DECODE_TRACK_CAP_MB, 1)).toBe(min)
    expect(clampSetting(AUDIO_DECODE_TRACK_CAP_MB, 512)).toBe(512)
  })

  it('clamps a total budget an operator tries to exceed', () => {
    const { min, max } = AUDIO_NUMERIC_BOUNDS.decodeResidencyBudgetMb

    expect(clampSetting(AUDIO_DECODE_RESIDENCY_BUDGET_MB, 1_000_000)).toBe(max)
    expect(clampSetting(AUDIO_DECODE_RESIDENCY_BUDGET_MB, 0)).toBe(min)
  })

  it('refuses a budget that is not a number at all, rather than clamping one', () => {
    // Falls back to the default: an operator cannot type this, but a store
    // written by a build with a different shape can hold it.
    expect(clampSetting(AUDIO_DECODE_TRACK_CAP_MB, 'lots')).toBe(AUDIO_DECODE_TRACK_CAP_MB.default)
    expect(clampSetting(AUDIO_DECODE_TRACK_CAP_MB, 250.5)).toBe(AUDIO_DECODE_TRACK_CAP_MB.default)
  })

  it('holds decode-ahead to the one slot the scheduler has', () => {
    expect(clampSetting(AUDIO_PREFETCH_DEPTH, 8)).toBe(AUDIO_NUMERIC_BOUNDS.prefetchDepth.max)
    expect(clampSetting(AUDIO_PREFETCH_DEPTH, -3)).toBe(AUDIO_NUMERIC_BOUNDS.prefetchDepth.min)
  })

  it('states the same bounds it enforces', () => {
    // `AUDIO_NUMERIC_BOUNDS` exists so the guard can re-clamp with the same
    // numbers. Two copies of a bound is exactly the kind of drift W8-9 removed
    // everywhere else, so drive both through the real validators.
    for (const [descriptor, bounds] of [
      [AUDIO_DECODE_TRACK_CAP_MB, AUDIO_NUMERIC_BOUNDS.decodeTrackCapMb],
      [AUDIO_DECODE_RESIDENCY_BUDGET_MB, AUDIO_NUMERIC_BOUNDS.decodeResidencyBudgetMb],
      [AUDIO_PREFETCH_DEPTH, AUDIO_NUMERIC_BOUNDS.prefetchDepth]
    ] as const) {
      expect(clampSetting(descriptor, bounds.max + 1)).toBe(bounds.max)
      expect(clampSetting(descriptor, bounds.min - 1)).toBe(bounds.min)
    }
  })
})

/**
 * W8-9's third "done when", as far as the registry can prove it on its own: the
 * keys the audio path needs all exist and are reachable. That the *renderer*
 * defaults are now these ones rather than copies is asserted in
 * `tests/renderer/audio/registryDefaults.test.ts`, which is the half that can
 * import both.
 */
describe('the audio domain', () => {
  it('registers every key the audio path reads', () => {
    for (const descriptor of [
      AUDIO_CROSSFADE_MS,
      AUDIO_REPLAY_GAIN_MODE,
      AUDIO_REPLAY_GAIN_PREAMP_DB,
      AUDIO_REPLAY_GAIN_FALLBACK_DB,
      AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING,
      AUDIO_OUTPUT_DEVICE,
      AUDIO_DECODE_TRACK_CAP_MB,
      AUDIO_DECODE_RESIDENCY_BUDGET_MB,
      AUDIO_PREFETCH_DEPTH
    ]) {
      expect(getSetting(descriptor.key)).toBe(descriptor)
    }
  })

  it('renders every audio key as a row on the settings surface', () => {
    const rows = settingsInCategory('audio')

    expect(rows.map((descriptor) => descriptor.key)).toEqual([
      AUDIO_CROSSFADE_MS.key,
      AUDIO_REPLAY_GAIN_MODE.key,
      AUDIO_REPLAY_GAIN_PREAMP_DB.key,
      AUDIO_REPLAY_GAIN_FALLBACK_DB.key,
      AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING.key,
      AUDIO_OUTPUT_DEVICE.key,
      AUDIO_DECODE_TRACK_CAP_MB.key,
      AUDIO_DECODE_RESIDENCY_BUDGET_MB.key,
      AUDIO_PREFETCH_DEPTH.key
    ])
    expect(auditRegistry()).toEqual([])
  })

  it('says the output device needs no restart, because it does not', () => {
    // The flag is load-bearing: W8-9 asked for it to tell the truth either way,
    // and the truth is that both paths reach the device through an AudioContext
    // that `AudioOutputRouter` re-points live.
    expect(AUDIO_OUTPUT_DEVICE.requiresRestart).toBe(false)
    expect(AUDIO_OUTPUT_DEVICE.default).toBe('')
  })

  it('keeps the R1 keys and the pre-amps behind the advanced flag', () => {
    for (const descriptor of [
      AUDIO_REPLAY_GAIN_PREAMP_DB,
      AUDIO_REPLAY_GAIN_FALLBACK_DB,
      AUDIO_DECODE_TRACK_CAP_MB,
      AUDIO_DECODE_RESIDENCY_BUDGET_MB,
      AUDIO_PREFETCH_DEPTH
    ]) {
      expect(descriptor.advanced).toBe(true)
    }
  })

  it('says in the help text what the R1 clamps will do', () => {
    // The card asks for this in as many words: a bound the operator only meets
    // by having their number changed under them is a bound they were not told
    // about.
    expect(AUDIO_DECODE_TRACK_CAP_MB.help).toContain('16–1024')
    expect(AUDIO_DECODE_RESIDENCY_BUDGET_MB.help).toContain('64–2048')
    expect(AUDIO_PREFETCH_DEPTH.help).toContain('one prefetch slot')
  })
})
