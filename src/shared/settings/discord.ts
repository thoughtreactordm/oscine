/**
 * Discord Rich Presence settings — the resolved value shape, its keys, and the
 * descriptors the settings UI generates itself from.
 *
 * Two halves that must not drift. The `DiscordSettings` *type* and
 * `DISCORD_SETTINGS_DEFAULTS` are what the pure activity mapping (`activity.ts`,
 * **W20-4**) and the presence service read; the `DISCORD_SETTINGS` *descriptors*
 * (**W20-3**) are what `settings.ts` folds into `SETTINGS_REGISTRY` so the row
 * for each key draws itself. The descriptors reuse the defaults object rather
 * than restating the values, so the registry and the mapping cannot disagree
 * about what "off" or "title and artist" means.
 *
 * Presence is opt-in by intent (D31): `enabled` defaults **off**, and the two
 * privacy-shaped defaults follow from that — `whenPaused` hides rather than
 * announcing a pause, and `showAlbumArt` is off *and* gated on the D14 consent
 * key, because a public cover lookup is the one part of the stream that reaches
 * the network. See `[[oscine-discord-presence]]`.
 */

import { NETWORK_EXTERNAL_LOOKUPS_KEY } from './network'
import {
  booleanValue,
  defineSetting,
  enumValue,
  type SettingDescriptor,
  type SettingOption
} from './kernel'

export const DISCORD_ENABLED = 'discord.enabled'
export const DISCORD_DISPLAY = 'discord.display'
export const DISCORD_SHOW_ALBUM_ART = 'discord.showAlbumArt'
export const DISCORD_SHOW_TIMESTAMP = 'discord.showTimestamp'
export const DISCORD_WHEN_PAUSED = 'discord.whenPaused'

/**
 * How much identifying detail the presence card carries — the privacy lever.
 * `generic` is the floor: it must leak neither title nor artist anywhere in the
 * payload.
 */
export type DiscordDisplay = 'title-artist' | 'title-only' | 'generic'

/** What presence does while the operator's track is paused. */
export type DiscordWhenPaused = 'hide' | 'paused'

/**
 * The resolved Discord settings the activity mapping reads. A plain value object
 * — the settings service resolves the cascade and hands this shape to the
 * presence service, which passes it to `buildActivity`.
 *
 * `showAlbumArt` is carried here even though `buildActivity` does not read it
 * yet: W20-5 swaps the static logo for a resolved public cover behind this flag,
 * and keeping the field beside the others is what lets that land as a mapping
 * change rather than a shape change.
 */
export interface DiscordSettings {
  readonly enabled: boolean
  readonly display: DiscordDisplay
  readonly showAlbumArt: boolean
  readonly showTimestamp: boolean
  readonly whenPaused: DiscordWhenPaused
}

/**
 * Defaults, reused by the descriptors below so the registry and the mapping
 * cannot drift. `enabled` is off — presence is opt-in (D31). Once on,
 * `title-artist` with a progress bar is the natural full-detail default;
 * `showAlbumArt` is off because it reaches the network; and a paused track
 * *hides* rather than announcing the pause, since the quieter choice is the
 * right floor for a broadcast the operator opted into for playing music.
 */
export const DISCORD_SETTINGS_DEFAULTS: DiscordSettings = Object.freeze({
  enabled: false,
  display: 'title-artist',
  showAlbumArt: false,
  showTimestamp: true,
  whenPaused: 'hide'
})

const DISPLAY_OPTIONS: readonly SettingOption<DiscordDisplay>[] = [
  { value: 'title-artist', label: 'Title and artist' },
  { value: 'title-only', label: 'Title only' },
  { value: 'generic', label: 'Listening to music' }
]

const WHEN_PAUSED_OPTIONS: readonly SettingOption<DiscordWhenPaused>[] = [
  { value: 'hide', label: 'Hide presence' },
  { value: 'paused', label: 'Show “Paused”' }
]

const DISCORD_KEYWORDS = ['discord', 'presence', 'rich presence', 'status', 'activity']

/**
 * The five descriptors, `category: 'network'` and `portable: false`.
 *
 * `portable: false` on every one, and for a stronger reason than the scrobbling
 * keys have: these describe a continuous outbound disclosure, so carrying them
 * across machines in a profile (W8-13) would turn broadcasting on somewhere the
 * operator never agreed to it — the same bypass D14's non-portable consent key
 * closes. Presence is a decision made per machine.
 */
export const DISCORD_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<boolean>({
    key: DISCORD_ENABLED,
    scope: 'durable',
    portable: false,
    default: DISCORD_SETTINGS_DEFAULTS.enabled,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'network',
    label: 'Show what you’re playing on Discord',
    help: 'Broadcast the current track to Discord as Rich Presence while Oscine and the Discord desktop app are both running. Off by default — nothing is shared until you turn this on, and everything below is inert while it is off.',
    keywords: [...DISCORD_KEYWORDS, 'broadcast', 'share', 'now playing', 'game'],
    order: 120
  }),
  defineSetting<DiscordDisplay>({
    key: DISCORD_DISPLAY,
    scope: 'durable',
    portable: false,
    default: DISCORD_SETTINGS_DEFAULTS.display,
    validate: enumValue<DiscordDisplay>(DISPLAY_OPTIONS.map((option) => option.value)),
    control: { kind: 'select', options: DISPLAY_OPTIONS },
    category: 'network',
    label: 'Detail to broadcast',
    help: 'How much of the track the presence card names. Title and artist shows the most; “Listening to music” names nothing at all.',
    keywords: [...DISCORD_KEYWORDS, 'title', 'artist', 'privacy', 'detail', 'generic'],
    order: 130
  }),
  defineSetting<boolean>({
    key: DISCORD_SHOW_ALBUM_ART,
    scope: 'durable',
    portable: false,
    default: DISCORD_SETTINGS_DEFAULTS.showAlbumArt,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'network',
    label: 'Show album art',
    help: 'Show the release cover on the presence card. This performs an online cover lookup; with it off, or with online lookups off, the Oscine logo is shown instead.',
    keywords: [
      ...DISCORD_KEYWORDS,
      'album',
      'art',
      'artwork',
      'cover',
      'image',
      'online',
      'lookup'
    ],
    // D14: a public cover lookup is an online request, so the toggle hangs off
    // the same consent every other network-dependent choice does rather than
    // inventing a second gate. W20-5 re-checks the same key live at the point of
    // use; this only makes the dependency visible instead of letting the toggle
    // silently do nothing.
    gatedBy: {
      key: NETWORK_EXTERNAL_LOOKUPS_KEY,
      note: 'Needs online lookups. Turn on “Allow online lookups” to fetch a public cover — until then the Oscine logo is shown.'
    },
    order: 140
  }),
  defineSetting<boolean>({
    key: DISCORD_SHOW_TIMESTAMP,
    scope: 'durable',
    portable: false,
    default: DISCORD_SETTINGS_DEFAULTS.showTimestamp,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'network',
    label: 'Show a progress bar',
    help: 'Show elapsed and remaining time as a progress bar on the presence card. Hidden automatically while paused, since a moving bar on a paused track would be a lie.',
    keywords: [...DISCORD_KEYWORDS, 'progress', 'time', 'timestamp', 'elapsed', 'remaining'],
    order: 150
  }),
  defineSetting<DiscordWhenPaused>({
    key: DISCORD_WHEN_PAUSED,
    scope: 'durable',
    portable: false,
    default: DISCORD_SETTINGS_DEFAULTS.whenPaused,
    validate: enumValue<DiscordWhenPaused>(WHEN_PAUSED_OPTIONS.map((option) => option.value)),
    control: { kind: 'select', options: WHEN_PAUSED_OPTIONS },
    category: 'network',
    label: 'While paused',
    help: 'What the presence card does while playback is paused: disappear, or stay and show “Paused”.',
    keywords: [...DISCORD_KEYWORDS, 'pause', 'paused', 'stop', 'idle'],
    order: 160
  })
]
