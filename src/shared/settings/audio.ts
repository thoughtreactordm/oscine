/**
 * Audio and playback keys.
 *
 * W8-5 seeded this file with enough keys to exercise the schema. W8-9 finished
 * it: every tunable the audio path had — the R1 admission constants, the
 * normalization defaults, the prefetch slot, the ReplayGain job's gate — is a
 * descriptor here, and the modules that used to hold their own copy now read
 * these. `DEFAULT_R1_POLICY` and `DEFAULT_NORMALIZATION_POLICY` still exist as
 * names, because a pure function needs a value rather than a store, but both are
 * now *derived* from this registry rather than declared beside it.
 *
 * Each descriptor is exported under its own name as well as through
 * `AUDIO_SETTINGS`. Consumers bind to the descriptor, not to a string: the
 * cascade's entity kinds survive in the descriptor's type, and a key rename
 * moves every call site with it.
 */

import {
  booleanValue,
  defineSetting,
  enumValue,
  integerValue,
  numberValue,
  stringValue,
  type SettingDescriptor,
  type SettingValidator
} from './kernel'

export type ReplayGainMode = 'off' | 'track' | 'album'
export type RepeatMode = 'off' | 'all' | 'one'

/**
 * Named because the playback controller binds to it by key.
 *
 * A literal there and a literal here would be two places to get the same string
 * right; the descriptor below is built from this one, so a rename moves both.
 */
export const AUDIO_CROSSFADE_MS_KEY = 'audio.crossfadeMs'

/**
 * Cascades because the whole point of a per-album crossfade is that a live
 * record wants one and a gapless concept record must not have one — the
 * invariant that gapless and crossfade are exclusive per boundary is decided at
 * the boundary, and the boundary belongs to an album or a playlist.
 *
 * Exported as a descriptor rather than only as a key, and defined without an
 * explicit `<number>`, so that its `cascade` survives into the type: a caller
 * that reaches for `resolveCascade(AUDIO_CROSSFADE_MS, { kind: 'track', id })`
 * fails to compile. `AUDIO_SETTINGS` erases that again, which is why the runtime
 * check exists too.
 *
 * The exclusivity invariant needs no separate guard here and could not have one:
 * a boundary reads exactly one resolved number, and the scheduler branches on
 * whether it is zero. There is no representable state in which a boundary is
 * both, at any level of the cascade — which is precisely what folding the
 * per-playlist column into this key buys. `boundaryPolicy` below is that branch,
 * named once so the three levels can be tested against the same function.
 */
export const AUDIO_CROSSFADE_MS = defineSetting({
  key: AUDIO_CROSSFADE_MS_KEY,
  scope: 'durable',
  default: 0,
  validate: integerValue({ min: 0, max: 12_000 }),
  cascade: ['album', 'playlist'],
  control: { kind: 'slider', min: 0, max: 12_000, step: 250, unit: 'ms' },
  category: 'audio',
  label: 'Crossfade',
  help: 'Zero means gapless. A boundary is one or the other, never both.',
  keywords: ['gapless', 'fade', 'transition'],
  order: 10
})

/**
 * What one boundary does, as a closed two-case answer.
 *
 * W8-9 asked for `audio.gapless.enabled` beside `audio.crossfadeMs` as a
 * validated pair. It is not written that way, and the reason is the invariant
 * itself: a pair has four states and two of them — gapless with a crossfade, and
 * neither — are exactly what "never both" forbids. Any validator policing them
 * would be repairing a state the schema should not have been able to hold, at
 * every level of the cascade, forever. One number has two states and they are
 * the two legal ones.
 *
 * So the pair is a *derivation*, not a stored second key, and this is it. The
 * card's requirement survives intact — the rule holds at every cascade level —
 * because there is no level at which a resolved crossfade is anything other than
 * a number this function accepts.
 *
 * Takes the resolved value from any level: the global, a playlist's override, an
 * album's. `resolveCascade` has already validated it, and this still normalizes,
 * because a value can also arrive from a build whose bounds differed.
 */
export interface BoundaryPolicy {
  mode: 'gapless' | 'crossfade'
  /** Zero exactly when `mode` is `gapless`. */
  crossfadeMs: number
}

export function boundaryPolicy(resolvedCrossfadeMs: number): BoundaryPolicy {
  const milliseconds =
    Number.isFinite(resolvedCrossfadeMs) && resolvedCrossfadeMs > 0
      ? Math.trunc(resolvedCrossfadeMs)
      : 0
  return milliseconds === 0
    ? { mode: 'gapless', crossfadeMs: 0 }
    : { mode: 'crossfade', crossfadeMs: milliseconds }
}

/**
 * Reconciled in W8-9 from `album` to `track`.
 *
 * W8-5 wrote `album` here while `DEFAULT_NORMALIZATION_MODE` in the renderer
 * said `track`, and the renderer's copy was the one playback actually used — so
 * the registry has been advertising a default the app did not have. Deleting the
 * renderer constant is what makes this key authoritative, and the moment it does,
 * the value here becomes the shipped behaviour. `track` is that behaviour, and
 * it is the documented M2 default; changing what people hear is not this card's
 * to do.
 */
export const AUDIO_REPLAY_GAIN_MODE = defineSetting<ReplayGainMode>({
  key: 'audio.replayGainMode',
  scope: 'durable',
  default: 'track',
  validate: enumValue<ReplayGainMode>(['off', 'track', 'album']),
  control: {
    kind: 'select',
    options: [
      { value: 'off', label: 'Off', help: 'Play every file at its recorded level.' },
      { value: 'track', label: 'Per track', help: 'Level every track the same.' },
      { value: 'album', label: 'Per album', help: 'Preserve dynamics within an album.' }
    ]
  },
  category: 'audio',
  label: 'Volume levelling',
  help: 'Which ReplayGain tag to apply when one is present.',
  keywords: ['replaygain', 'normalisation', 'loudness', 'gain'],
  order: 20
})

export const AUDIO_REPLAY_GAIN_PREAMP_DB = defineSetting<number>({
  key: 'audio.replayGainPreampDb',
  scope: 'durable',
  default: 0,
  validate: numberValue({ min: -15, max: 15 }),
  control: { kind: 'slider', min: -15, max: 15, step: 0.5, unit: 'dB' },
  category: 'audio',
  label: 'Levelling pre-amp',
  help: 'Applied on top of the ReplayGain adjustment. Peak limiting still applies.',
  keywords: ['replaygain', 'preamp', 'headroom'],
  order: 30,
  advanced: true
})

/**
 * The other half of the pre-amp, and deliberately a separate knob.
 *
 * A library is never uniformly tagged. The pre-amp moves tracks that *have* a
 * measurement; this moves the ones that do not, which is the only way an
 * untagged track can sit at the same loudness as its neighbours. They are not
 * one setting with two names: raising the pre-amp and raising this pull in
 * opposite directions on the gap between tagged and untagged material.
 *
 * Negative by default is tempting and wrong — an untagged library would get
 * quieter for no reason the operator asked for. Zero changes nothing until it is
 * moved.
 */
export const AUDIO_REPLAY_GAIN_FALLBACK_DB = defineSetting<number>({
  key: 'audio.replayGainFallbackDb',
  scope: 'durable',
  default: 0,
  validate: numberValue({ min: -15, max: 15 }),
  control: { kind: 'slider', min: -15, max: 15, step: 0.5, unit: 'dB' },
  category: 'audio',
  label: 'Untagged track gain',
  help: 'Applied to tracks with no ReplayGain measurement. No peak is known for these, so a positive value can clip.',
  keywords: ['replaygain', 'fallback', 'untagged', 'missing'],
  order: 40,
  advanced: true
})

/**
 * The gate on the analysis job.
 *
 * True is what the app already does — the job runs when it is asked to — so the
 * default changes nothing. False makes the refusal explicit rather than leaving
 * an operator who does not want their library decoded to remember not to press
 * the button.
 *
 * Read in main, before any window exists, which is the case durable scope is for.
 */
export const AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING = defineSetting<boolean>({
  key: 'audio.replayGainComputeWhenMissing',
  scope: 'durable',
  default: true,
  validate: booleanValue(),
  control: { kind: 'toggle' },
  category: 'audio',
  label: 'Analyse untagged tracks',
  help: 'Allow the background job to measure ReplayGain for tracks that have no tag. Turning this off refuses the job; it never discards a measurement already taken.',
  keywords: ['replaygain', 'analyse', 'analyze', 'scan', 'job', 'background'],
  order: 50
})

/**
 * The default device is the empty string, and the empty string is not a device
 * id — it is "whatever the OS says", which is what `setSinkId('')` means.
 *
 * `requiresRestart` is false because it is false: both audio paths reach their
 * device through an `AudioContext`, `AudioContext.setSinkId` is live on the
 * Chromium this ships against, and `probe:media-session` is the kind of thing
 * that would catch it changing. A key whose flag claimed a restart the engine
 * does not need would be a worse lie than a missing key.
 *
 * Machine-local in every sense, but still durable rather than view scope: main
 * has no business resolving it, yet a second window on the same machine must not
 * get a different device. W8-13 excludes it from the export bundle by key.
 */
export const AUDIO_OUTPUT_DEVICE = defineSetting<string>({
  key: 'audio.outputDevice',
  scope: 'durable',
  // The one durable key that names hardware. A device label is meaningful only
  // on the machine that enumerated it, and importing one would silently point
  // playback at a sink that is not there — so the profile leaves it behind, and
  // the help text below is now a promise the exporter keeps rather than a note.
  portable: false,
  default: '',
  validate: stringValue({ maxLength: 256, allowEmpty: true }),
  control: { kind: 'custom', component: 'OutputDeviceControl' },
  category: 'audio',
  label: 'Output device',
  help: 'Where audio is sent. Takes effect immediately. Not carried between machines.',
  keywords: ['device', 'output', 'sink', 'sound card', 'headphones', 'dac'],
  order: 60,
  requiresRestart: false
})

// --- R1's admission guard ----------------------------------------------------
//
// These three were constants in `r1Admission.ts` and in the scheduler. They are
// `advanced` because the operator who needs them is the one whose library broke
// the defaults, and the help text on each says what the guard will do to a value
// it considers unsafe — the clamps below are not the last word, because
// `resolveR1Policy` re-applies them at the factory boundary. A descriptor bound
// is a nicer error; the guard's own bound is the one that has to hold.

/** Both R1 byte budgets are stated in MiB. `r1Admission` converts once. */
export const MIB = 1024 ** 2

export const AUDIO_DECODE_TRACK_CAP_MB = defineSetting<number>({
  key: 'audio.decodeTrackCapMb',
  scope: 'durable',
  default: 250,
  validate: integerValue({ min: 16, max: 1024 }),
  control: { kind: 'number', min: 16, max: 1024, step: 16, unit: 'MiB' },
  category: 'audio',
  label: 'Decode cap per track',
  help: 'A track whose decoded audio would exceed this streams instead. Clamped to 16–1024 MiB: above that a long-track library can exhaust the renderer before the budget below is ever consulted.',
  keywords: ['r1', 'memory', 'decode', 'buffer', 'streaming'],
  order: 70,
  advanced: true
})

export const AUDIO_DECODE_RESIDENCY_BUDGET_MB = defineSetting<number>({
  key: 'audio.decodeResidencyBudgetMb',
  scope: 'durable',
  default: 600,
  validate: integerValue({ min: 64, max: 2048 }),
  control: { kind: 'number', min: 64, max: 2048, step: 64, unit: 'MiB' },
  category: 'audio',
  label: 'Total decode budget',
  help: 'Decoded audio held across the playing and prefetched tracks together, including the transient peak while a track decodes. Clamped to 64–2048 MiB. Setting it below the per-track cap is allowed and simply means fewer tracks are admitted.',
  keywords: ['r1', 'memory', 'decode', 'budget', 'residency'],
  order: 80,
  advanced: true
})

/**
 * One, or none.
 *
 * The scheduler holds exactly one prefetch slot — that is what makes a
 * sample-accurate join possible, and a second slot would need a second engine
 * and a second reservation against the same budget. So the honest range is 0–1,
 * and the help says so rather than offering a depth the scheduler would ignore.
 * Zero is the setting for a machine where decode-ahead costs more than the gap
 * it removes.
 */
export const AUDIO_PREFETCH_DEPTH = defineSetting<number>({
  key: 'audio.prefetchDepth',
  scope: 'durable',
  default: 1,
  validate: integerValue({ min: 0, max: 1 }),
  control: { kind: 'number', min: 0, max: 1, step: 1 },
  category: 'audio',
  label: 'Decode-ahead depth',
  help: 'How many upcoming tracks to prepare. The scheduler has one prefetch slot, so one is the maximum; zero disables decode-ahead and with it the gapless join.',
  keywords: ['prefetch', 'decode', 'ahead', 'buffer', 'gapless'],
  order: 90,
  advanced: true
})

/**
 * View-scoped: which order you left the transport in is a fact about this
 * window on this machine, not a preference worth carrying to another one.
 */
export const PLAYBACK_REPEAT = defineSetting<RepeatMode>({
  key: 'playback.repeat',
  scope: 'view',
  default: 'off',
  validate: enumValue<RepeatMode>(['off', 'all', 'one']),
  control: {
    kind: 'select',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'all', label: 'Repeat queue' },
      { value: 'one', label: 'Repeat track' }
    ]
  },
  category: 'playback',
  label: 'Repeat',
  help: 'Restored when the window reopens.',
  order: 10
})

export const PLAYBACK_SHUFFLE = defineSetting<boolean>({
  key: 'playback.shuffle',
  scope: 'view',
  default: false,
  validate: booleanValue(),
  control: { kind: 'toggle' },
  category: 'playback',
  label: 'Shuffle',
  help: 'Restored when the window reopens.',
  order: 20
})

/**
 * View-scoped for the same reason shuffle and repeat are: how loud the
 * transport was is a fact about this window on this machine, not a
 * preference worth carrying to another one.
 *
 * Internal because the slider on the transport is the only control — a
 * second one on the settings pane would create two ways to set the same
 * thing, and the transport's is better because it is beside the music.
 */
export const PLAYBACK_VOLUME = defineSetting<number>({
  key: 'playback.volume',
  scope: 'view',
  default: 1,
  validate: numberValue({ min: 0, max: 1 }),
  category: 'playback',
  label: 'Volume',
  help: 'Restored when the window reopens.',
  internal: true,
  order: 30
})

export const AUDIO_SETTINGS: readonly SettingDescriptor[] = [
  AUDIO_CROSSFADE_MS,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB,
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING,
  AUDIO_OUTPUT_DEVICE,
  AUDIO_DECODE_TRACK_CAP_MB,
  AUDIO_DECODE_RESIDENCY_BUDGET_MB,
  AUDIO_PREFETCH_DEPTH,
  PLAYBACK_REPEAT,
  PLAYBACK_SHUFFLE,
  PLAYBACK_VOLUME
]

/**
 * The numeric bounds a descriptor advertises, readable without the descriptor.
 *
 * `resolveR1Policy` needs the same numbers to re-clamp with, and reading them
 * off the validator is not possible — a `SettingValidator` is a function. Stating
 * them once here and building both the descriptor and the guard from it would be
 * nicer still; it is not done because `integerValue` takes them positionally and
 * the indirection would cost more clarity at the descriptor than it saves here.
 * The audit in `tests/shared/audioSettings.test.ts` is what keeps the two honest:
 * it drives every bound through the real validator.
 */
export const AUDIO_NUMERIC_BOUNDS = Object.freeze({
  decodeTrackCapMb: Object.freeze({ min: 16, max: 1024 }),
  decodeResidencyBudgetMb: Object.freeze({ min: 64, max: 2048 }),
  prefetchDepth: Object.freeze({ min: 0, max: 1 })
})

/**
 * Clamp through a descriptor's own validator, falling back to its default.
 *
 * The guard-side clamp and the settings-side clamp are then the same code rather
 * than the same numbers written twice.
 */
export function clampSetting<T>(descriptor: SettingDescriptor<T>, raw: unknown): T {
  const validate: SettingValidator<T> = descriptor.validate
  const result = validate(raw)
  return result.ok ? result.value : descriptor.default
}
