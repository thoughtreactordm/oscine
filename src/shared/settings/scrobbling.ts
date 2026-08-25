/**
 * Scrobbling keys — the pause switch, **D19**'s escape hatch, and the loved-push
 * gate.
 *
 * ## The escape hatch
 *
 * Two keys, both empty by default, both meaning "use the pair Oscine ships
 * with". They exist because a shipped API key is a single point of failure that
 * belongs to somebody else: if Last.fm ever revokes or rate-limits Oscine's,
 * every install breaks at once, and without these an operator's only recourse is
 * to wait for a release. With them it is a paste.
 *
 * ## Why the *app* key is a setting and the session key is not
 *
 * This is the distinction D19 turns on, and putting the two credentials in
 * different places is how the code states it. The app key says *which
 * application is asking*; it identifies Oscine, ships in the bundle, is
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

import type { ScrobbleTargetId } from '../scrobble'
import { booleanValue, defineSetting, stringValue, type SettingDescriptor } from './kernel'

export const LASTFM_ENABLED = 'lastfm.enabled'
export const LASTFM_API_KEY = 'lastfm.apiKey'
export const LASTFM_API_SECRET = 'lastfm.apiSecret'
export const LASTFM_LOVE_ON_FAVORITE = 'lastfm.loveOnFavorite'

/**
 * Which key pauses which target — the map the main process filters through.
 *
 * `Partial` on purpose, and the absent case means *on*. A target with no switch
 * is a target whose only gate is whether it is connected, which is what every
 * target was before this key existed; the alternative is a lookup that throws
 * for an id the registry has not caught up with, which turns a missing setting
 * into a scrobble that never sends. ListenBrainz gets its entry in W11-8, in the
 * same commit that gives it a target to switch off.
 */
export const SCROBBLE_ENABLED_KEYS: Readonly<Partial<Record<ScrobbleTargetId, string>>> =
  Object.freeze({
    lastfm: LASTFM_ENABLED
  })

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
  'Optional. Leave both fields empty to use the API key Oscine ships with — that is the ' +
  'normal setup and nothing needs to be entered here. Fill in both to use your own ' +
  'application registered at last.fm/api/account/create, which is the way out if Oscine’s ' +
  'key is ever rate-limited or withdrawn. One field on its own is ignored: a key cannot ' +
  'sign without its secret.'

export const SCROBBLING_SETTINGS: readonly SettingDescriptor[] = [
  // The pause switch, and deliberately not the same thing as being connected.
  //
  // Disconnecting throws the session key away and costs a round trip through
  // the browser to undo; "don't scrobble the next hour of this" should cost a
  // toggle. Off means off everywhere — nothing is enqueued, nothing is
  // announced as now-playing, and the drain leaves the queue alone — because a
  // switch that stopped two of the three would be a switch the operator has to
  // learn the exceptions to. What it never does is discard: rows already queued
  // are listens that happened, and they wait.
  defineSetting<boolean>({
    key: LASTFM_ENABLED,
    scope: 'durable',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'network',
    label: 'Scrobble to Last.fm',
    help: 'Send what you play to Last.fm while an account is connected. Turning this off pauses scrobbling, now-playing and the loved push without signing you out — anything already waiting to send stays queued until you turn it back on.',
    keywords: ['lastfm', 'last.fm', 'scrobble', 'scrobbling', 'pause', 'enable'],
    order: 80
  }),
  // Portable, where the two below are not, and the difference is the same one
  // this file is about: a key pasted on one machine is usually registered for a
  // reason local to it, while "push my hearts to Last.fm" is a preference about
  // how the operator likes Oscine to behave and travels with them. It carries
  // nothing that identifies an account — with no session key on the second
  // machine it does nothing at all until one is connected there too.
  defineSetting<boolean>({
    key: LASTFM_LOVE_ON_FAVORITE,
    scope: 'durable',
    // On, because the operator who connected an account asked for their
    // listening to be reflected there and a heart is part of that. What the
    // default cannot do is act on its own: with no account connected this is
    // read, found true, and enqueues nothing, because there is nowhere to send
    // it — and connecting one later pushes none of the hearts that already
    // exist. Forward-only is a property of where the enqueue happens (W11-6),
    // not of this flag.
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'network',
    label: 'Love favorited tracks on Last.fm',
    help: 'Hearting a track in Oscine also loves it on Last.fm, and un-hearting it removes the love. Favorites already in your library are never pushed, and Last.fm’s loved tracks are never read back in — your favorites here stay the authoritative copy.',
    keywords: ['lastfm', 'last.fm', 'love', 'loved', 'favorite', 'favourite', 'heart', 'scrobble'],
    order: 90
  }),
  defineSetting<string>({
    key: LASTFM_API_KEY,
    scope: 'durable',
    portable: false,
    default: '',
    // `allowEmpty`, because empty is not an unfilled field here — it is the
    // value that means "ship's key", and it is what almost every install has.
    validate: stringValue({ maxLength: 128, allowEmpty: true }),
    control: { kind: 'text', placeholder: 'Uses Oscine’s key when empty' },
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
    control: { kind: 'text', placeholder: 'Uses Oscine’s secret when empty' },
    category: 'network',
    label: 'Last.fm shared secret',
    help: LASTFM_APP_KEY_HELP,
    keywords: ['lastfm', 'last.fm', 'scrobble', 'scrobbling', 'api', 'secret'],
    advanced: true,
    order: 110
  })
]
