/**
 * Scrobbling keys — **D19**'s escape hatch, and nothing else yet.
 *
 * Two keys, both empty by default, both meaning "use the pair Fermata ships
 * with". They exist because a shipped API key is a single point of failure that
 * belongs to somebody else: if Last.fm ever revokes or rate-limits Fermata's,
 * every install breaks at once, and without these an operator's only recourse is
 * to wait for a release. With them it is a paste.
 *
 * ## Why the *app* key is a setting and the session key is not
 *
 * This is the distinction D19 turns on, and putting the two credentials in
 * different places is how the code states it. The app key says *which
 * application is asking*; it identifies Fermata, ships in the bundle, is
 * extractable from the asar, and on its own can scrobble for nobody. It is a
 * configuration value and it lives here, in the settings table, with the rest of
 * them.
 *
 * The session key says *who is asking*, is worth an account to whoever holds it,
 * and lives in `safeStorage` — never here, never in a settings export, never
 * across IPC. Conflating them is the mistake D19 exists to avoid; two storage
 * locations with two different rules is what not conflating them looks like.
 *
 * ## Why they are not portable
 *
 * `portable: false`, so W8-13's profile export leaves them behind. Not for
 * secrecy — an API key is not a secret — but because a pair pasted on one
 * machine is usually one registered for a reason that is local: a personal
 * account, a quota, an experiment. Carrying it silently onto a second install
 * makes both machines share a rate limit that neither operator asked to share.
 *
 * ## The `text` control arrived with these
 *
 * Until now every string in the registry was a path or a choice, so
 * `SettingControl` had no kind for "a value the operator pastes". These two keys
 * needed one — and needed it *now* rather than in W11-7, because they are the
 * escape hatch that makes a build with no shipped key usable at all. It is one
 * case in `SettingControl.vue` and one member of the union.
 *
 * The pane proper, and the connect/disconnect controls that are not declarative
 * at all, are W11-7.
 */

import { defineSetting, stringValue, type SettingDescriptor } from './kernel'

export const LASTFM_API_KEY = 'lastfm.apiKey'
export const LASTFM_API_SECRET = 'lastfm.apiSecret'

/**
 * Both fields, or neither.
 *
 * A key without its secret cannot sign a request and a secret without its key
 * cannot name an application, so a half-filled override is not a weaker override
 * — it is a build that fails at `auth.getSession` with a signature error and no
 * clue why. `resolveLastfmAppKey` in main treats a half-filled pair as absent
 * and says so; this constant is here so the help text and that rule quote the
 * same sentence.
 */
export const LASTFM_APP_KEY_HELP =
  'Optional. Leave both fields empty to use the API key Fermata ships with — that is the ' +
  'normal setup and nothing needs to be entered here. Fill in both to use your own ' +
  'application registered at last.fm/api/account/create, which is the way out if Fermata’s ' +
  'key is ever rate-limited or withdrawn. One field on its own is ignored: a key cannot ' +
  'sign without its secret.'

export const SCROBBLING_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<string>({
    key: LASTFM_API_KEY,
    scope: 'durable',
    portable: false,
    default: '',
    // `allowEmpty`, because empty is not an unfilled field here — it is the
    // value that means "ship's key", and it is what almost every install has.
    validate: stringValue({ maxLength: 128, allowEmpty: true }),
    control: { kind: 'text', placeholder: 'Uses Fermata’s key when empty' },
    category: 'network',
    label: 'Last.fm API key',
    help: LASTFM_APP_KEY_HELP,
    keywords: ['lastfm', 'last.fm', 'scrobble', 'scrobbling', 'api', 'key'],
    advanced: true,
    order: 100
  }),
  defineSetting<string>({
    key: LASTFM_API_SECRET,
    scope: 'durable',
    portable: false,
    default: '',
    validate: stringValue({ maxLength: 128, allowEmpty: true }),
    control: { kind: 'text', placeholder: 'Uses Fermata’s secret when empty' },
    category: 'network',
    label: 'Last.fm shared secret',
    help: LASTFM_APP_KEY_HELP,
    keywords: ['lastfm', 'last.fm', 'scrobble', 'scrobbling', 'api', 'secret'],
    advanced: true,
    order: 110
  })
]
