import type { PresenceSignal } from '@shared/presence'
import type { DiscordSettings } from '@shared/settings/discord'
import { OSCINE_LOGO_ASSET_KEY } from './appId'
import type { DiscordActivity } from './client'

/**
 * The pure signal→activity mapping — **W20-4**.
 *
 * `buildActivity(settings, signal, now)` turns a `PresenceSignal` into the
 * Discord activity to broadcast, or `null` to clear presence. It is a total,
 * side-effect-free function — the same property `equalPower.ts`,
 * `gaplessTiming.ts` and `normalization.ts` have — so it is unit-tested with no
 * Web Audio and no socket: same inputs, same output, and the only clock reading
 * is the `now` passed in, which keeps the timestamp math deterministic. The
 * throttle, the dedupe and the connection live in `service.ts`; nothing here
 * touches the client. See `[[oscine-discord-presence]]` D31.
 */

/** Discord activity type `2` — "Listening to <app>". */
export const DISCORD_ACTIVITY_TYPE_LISTENING = 2

/**
 * `status_display_type` values — which field the "Listening to X" status line
 * mirrors. See `DiscordActivity.status_display_type`.
 */
export const STATUS_DISPLAY_NAME = 0
export const STATUS_DISPLAY_STATE = 1
export const STATUS_DISPLAY_DETAILS = 2

/**
 * The `generic` display floor: a fixed line carrying no track detail. Must never
 * be joined by a title or artist anywhere in the payload — that is the whole
 * point of the privacy floor.
 */
export const GENERIC_DETAILS = 'Listening to music'

/** The paused card's second line, in place of the artist — an explicit, leak-free indicator. */
const PAUSED_STATE = 'Paused'

/** Round a millisecond timestamp to whole seconds, so a steadily-playing track yields a stable start/end and heartbeats dedupe. */
function toWholeSeconds(ms: number): number {
  return Math.round(ms / 1000) * 1000
}

/**
 * The first/second lines for a display mode. `generic` returns only the fixed
 * floor line; the title modes return the title, and `title-artist` adds the
 * artist as the second line when there is one (a track with no artist collapses
 * to title-only rather than showing a blank second line).
 */
function detailLines(
  display: DiscordSettings['display'],
  track: NonNullable<PresenceSignal['track']>
): { details: string; state?: string } {
  if (display === 'generic') return { details: GENERIC_DETAILS }
  if (display === 'title-only') return { details: track.title }
  // title-artist
  return track.artist ? { details: track.title, state: track.artist } : { details: track.title }
}

export function buildActivity(
  settings: DiscordSettings,
  signal: PresenceSignal,
  now: number
): DiscordActivity | null {
  // Off, stopped, or idle — clear presence. `playing: false` / `track: null` is
  // the explicit clear state (W20-1); disabled is the operator's opt-out (D31).
  if (!settings.enabled) return null
  if (!signal.playing || signal.track === null) return null

  const track = signal.track
  const paused = signal.paused

  if (paused && settings.whenPaused === 'hide') return null

  const { details, state } = detailLines(settings.display, track)

  const activity: DiscordActivity = { type: DISCORD_ACTIVITY_TYPE_LISTENING, details }

  // The compact status line ("Listening to X") mirrors the song (details)
  // rather than the app name — except at the generic floor, where it must stay
  // the app name so no title leaks into the status text. (A future W20 card
  // lets the operator template this line with {title}/{artist} tokens; the field
  // it points at stays the seam.)
  activity.status_display_type =
    settings.display === 'generic' ? STATUS_DISPLAY_NAME : STATUS_DISPLAY_DETAILS

  // A paused track shows "Paused" in place of the artist rather than a running
  // second line; a playing one keeps whatever the display mode chose.
  if (paused) {
    activity.state = PAUSED_STATE
  } else if (state !== undefined) {
    activity.state = state
  }

  // Timestamps drive the progress bar, so they belong only on a genuinely
  // advancing track: never when paused (a moving bar on a paused track is a
  // lie) and never when the operator turned the bar off. `start` is anchored in
  // the past by how far the track has already played.
  if (settings.showTimestamp && !paused) {
    const start = toWholeSeconds(now - signal.positionMs)
    activity.timestamps = { start, end: start + toWholeSeconds(track.durationMs) }
  }

  // The large image is the static logo for now (W20-5 swaps in the real cover).
  // Its hover label is the slot a listener reads as the album — so it carries
  // the real album, never a constant that would read as a bogus one. Only at the
  // full-detail level and only when there is one: `title-only` and `generic`
  // promised less than an album name, so they omit it (and generic must not leak).
  const assets: NonNullable<DiscordActivity['assets']> = { large_image: OSCINE_LOGO_ASSET_KEY }
  if (settings.display === 'title-artist' && track.album) {
    assets.large_text = track.album
  }
  activity.assets = assets

  return activity
}
