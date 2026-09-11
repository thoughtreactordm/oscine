/**
 * Discord Rich Presence settings — the resolved value shape and its keys.
 *
 * **W20-4** defines only the *type* the activity mapping consumes and sensible
 * defaults; the settings *descriptors* (the `defineSetting` literals, the
 * generated UI, the onboarding network step) are **W20-3**, which registers them
 * into `SETTINGS_REGISTRY` and reads them through the settings service. Keeping
 * the type here — not inside `activity.ts` — is what lets W20-3's descriptors and
 * W20-4's pure mapping agree on one shape without either importing the other.
 *
 * Presence is opt-in by intent (D31): `enabled` defaults **off**. Everything
 * else describes what is broadcast once the operator turns it on. Album art has
 * no field yet — it is W20-5, gated on D14 — so the mapping's `largeImageKey` is
 * the static logo until then. See `[[oscine-discord-presence]]`.
 */

export const DISCORD_ENABLED = 'discord.enabled'
export const DISCORD_DISPLAY = 'discord.display'
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
 */
export interface DiscordSettings {
  readonly enabled: boolean
  readonly display: DiscordDisplay
  readonly showTimestamp: boolean
  readonly whenPaused: DiscordWhenPaused
}

/**
 * Defaults, reused by W20-3's descriptors so the registry and the mapping cannot
 * drift. `enabled` is off — presence is opt-in (D31). Once on, `title-artist`
 * with a progress bar is the natural full-detail default, and a paused track
 * shows a "Paused" card rather than vanishing.
 */
export const DISCORD_SETTINGS_DEFAULTS: DiscordSettings = Object.freeze({
  enabled: false,
  display: 'title-artist',
  showTimestamp: true,
  whenPaused: 'paused'
})
