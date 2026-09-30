/**
 * The playback signal Discord Rich Presence needs — **W20-1**, D31.
 *
 * A second consumer of the now-playing moment, and a deliberately separate one.
 * `NowPlayingPayload` (`./scrobble`) is thin because scrobbling needs nothing
 * more than artist/title/album/duration; presence needs two things it does not
 * carry — where in the track the operator has reached, and whether it is paused
 * — because Rich Presence renders a progress bar from a start/end timestamp and
 * must visibly pause or clear. Widening `NowPlayingPayload` to bolt those on
 * would make scrobbling start carrying a position it never sends, and the two
 * consumers want different cadences, so this is a signal of its own. See
 * `[[oscine-discord-presence]]` D31.
 *
 * It carries no Discord vocabulary. The mapping from this shape to a Discord
 * activity — `largeImageKey`, `startTimestamp`, the display-detail choices — is
 * W20-3's job and stays main-side; this is plain playback data.
 */

/**
 * The track half of the signal.
 *
 * Durations are in **milliseconds**, the unit the renderer already counts in —
 * unlike `ScrobblePayload.durationSeconds`, which is seconds because it is a wire
 * field for services that define it so. `album` and `albumArtist` are optional
 * because a single or an unfiled track has neither, and presence simply omits
 * them rather than inventing a blank line.
 */
export interface PresenceTrack {
  readonly title: string
  readonly artist: string | null
  readonly album?: string | null
  readonly albumArtist?: string | null
  /** Total track length in ms, for the progress bar's far end. */
  readonly durationMs: number
}

/**
 * One presence update, renderer→main.
 *
 * `track: null` together with `playing: false` is the explicit "clear presence"
 * state — nothing is loaded and main should take the activity down — not an
 * omission the consumer has to infer.
 *
 * `paused` and `playing` are independent: `playing` is whether a track is loaded
 * at all (false only when stopped or idle), `paused` whether that loaded track
 * is paused. A paused track is therefore `playing: true, paused: true`, which is
 * what lets presence show "Paused" (per `discord.whenPaused`) rather than simply
 * disappear.
 *
 * `positionMs` is where the track has reached, in ms, measured against
 * `track.durationMs`: the frozen position on a paused signal, the position at
 * the instant of emission on a playing one.
 */
export interface PresenceSignal {
  readonly track: PresenceTrack | null
  readonly positionMs: number
  readonly paused: boolean
  readonly playing: boolean
}
