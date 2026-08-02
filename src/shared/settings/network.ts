/**
 * Network keys — **D14**'s consent gate, and nothing else.
 *
 * One key, defaulting to off, and every outbound request Fermata makes on its
 * own initiative reads it before opening a socket. That the default is `false`
 * rather than `true` is the whole decision: an operator who never opens this
 * category never contacts anyone, and no code path anywhere has to remember to
 * ask first.
 *
 * ## Why the key is not portable
 *
 * `portable: false` on a durable key is unusual — the flag normally marks the
 * ones that describe *this machine*, and consent describes a person rather than
 * a machine. It is set anyway, because W8-13's profile import would otherwise
 * be a way to turn networking on without anyone agreeing to it on the machine
 * it would happen from. A profile that silently grants consent is exactly the
 * bypass D14's first rule exists to close, and "the operator exported this
 * profile themselves, probably" is not the standard a privacy gate is held to.
 * Carrying the decision across machines is worth less than the guarantee that
 * it was made on each of them.
 *
 * ## What it does not gate
 *
 * Hosts the operator named. A podcast feed pasted into the subscribe box, and
 * the episode audio that feed points at, are requests the operator asked for by
 * asking for them; gating those behind this toggle would read as broken rather
 * than as careful. This key gates the lookups *Fermata* decides to make —
 * currently MusicBrainz and Wikipedia for artist information, and W9-5 will
 * bring Apple's podcast catalogue under it too, since browsing a catalogue is
 * Fermata's idea of what to fetch rather than the operator's.
 */

import { booleanValue, defineSetting, type SettingDescriptor } from './kernel'

export const NETWORK_EXTERNAL_LOOKUPS_KEY = 'network.externalLookups'

export const NETWORK_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<boolean>({
    key: NETWORK_EXTERNAL_LOOKUPS_KEY,
    scope: 'durable',
    portable: false,
    default: false,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'network',
    label: 'Look up artist information online',
    help:
      'Off by default. When on, Fermata sends the playing artist’s name to MusicBrainz and ' +
      'Wikipedia to fill in biographies, relations and links, and caches the replies beside ' +
      'your library. Your library, your plays and your files are never sent.',
    keywords: [
      'network',
      'internet',
      'online',
      'offline',
      'privacy',
      'consent',
      'musicbrainz',
      'wikipedia',
      'wikidata',
      'metadata',
      'lookup'
    ],
    order: 10
  })
]
