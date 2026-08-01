/**
 * Audio and playback keys.
 *
 * The seed set for W8-5: enough to exercise every part of the schema that
 * matters here — a cascading key, both scopes, three control kinds — and the
 * pattern the rest of the domain extends. Every default in this file is the one
 * the code currently hardcodes; W8-3 is what deletes the hardcoded copies.
 */

import {
  booleanValue,
  defineSetting,
  enumValue,
  integerValue,
  numberValue,
  type SettingDescriptor
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
 * per-playlist column into this key buys.
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

export const AUDIO_SETTINGS: readonly SettingDescriptor[] = [
  AUDIO_CROSSFADE_MS,

  defineSetting<ReplayGainMode>({
    key: 'audio.replayGainMode',
    scope: 'durable',
    default: 'album',
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
  }),

  defineSetting<number>({
    key: 'audio.replayGainPreampDb',
    scope: 'durable',
    default: 0,
    validate: numberValue({ min: -15, max: 15 }),
    control: { kind: 'slider', min: -15, max: 15, step: 0.5, unit: 'dB' },
    category: 'audio',
    label: 'Levelling pre-amp',
    help: 'Applied on top of the ReplayGain adjustment.',
    keywords: ['replaygain', 'preamp', 'headroom'],
    order: 30,
    advanced: true
  }),

  /**
   * View-scoped: which order you left the transport in is a fact about this
   * window on this machine, not a preference worth carrying to another one.
   */
  defineSetting<RepeatMode>({
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
  }),

  defineSetting<boolean>({
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
]
