import type { Track } from './library'

/**
 * The play-history trail: what has been played, most recent first.
 *
 * ## What counts as a play
 *
 * One row at the moment the transport commits to a track — the same moment the
 * scheduler announces it — **skips included**. This is a record of what the
 * transport did, not a scrobble log, and the difference is the whole point of
 * the trail: the track you skipped past three seconds in is precisely the one
 * jump-back exists to reach. A listened-threshold would omit it.
 *
 * That is also why nothing here writes `tracks.play_count` or
 * `tracks.last_played_at`. Those two columns want the other definition — a play
 * you actually listened to — and inflating them with skips to save a second
 * event would make the number D11's export bundle carries a lie. They stay
 * unwritten until a card owns them.
 *
 * ## D11
 *
 * The trail is **excluded** from the export/import bundle. See the design
 * document's D11 amendment: the bundle carries statements about *tracks* —
 * playlists, ratings, play counts — which merge across machines because they
 * are aggregates. A trail is a statement about a *session on one machine*, and
 * two of them merged is a chronology that never happened.
 */

/**
 * How many plays the trail keeps. Older rows are evicted on write.
 *
 * A row cap rather than a time window because a window's storage is unbounded —
 * a fortnight is a hundred plays for one operator and four thousand for another
 * — while a cap states the disk cost outright. Five hundred plays is roughly
 * thirty-three hours of listening, which is a session view rather than an
 * archive, and it is small enough that the trail is read whole in one request.
 * There is no page two, because the cap *is* the page.
 */
export const PLAY_HISTORY_CAP = 500

/** One play. `id` is the trail's ordering key — see `ListPlayHistoryQuery`. */
export interface PlayEntry {
  /**
   * Monotonic, and the order the plays actually happened in.
   *
   * The trail sorts on this rather than on `playedAt` because a system clock
   * can go backwards — an NTP correction, a laptop waking in another timezone —
   * and a row id cannot. The two disagree only when the clock was wrong, and
   * the id is the one that is still right about the sequence.
   */
  readonly id: number
  /** Wall-clock milliseconds, stamped in main. Displayed, never sorted on. */
  readonly playedAt: number
  /**
   * The track as it is indexed *now*, not as it was when it played.
   *
   * Resolved by join rather than snapshotted, unlike `QueueEntry.track`: a
   * queue entry has to survive its playlist being deleted (§5 rule 4), whereas
   * a trail row that cannot be jumped back to is a dead row. A track that
   * leaves the library takes its history with it — see the migration.
   */
  readonly track: Track
}

export interface ListPlayHistoryQuery {
  /** Rows to return, most recent first. Clamped to `PLAY_HISTORY_CAP`. */
  limit: number
}
