/**
 * "Currently playing", announced at the moment the transport commits — **D19**,
 * W11-5.
 *
 * ## Why this moment and no other
 *
 * A now-playing notification has a short server-side expiry and no history: it
 * describes what is happening, and the only honest time to send it is when it
 * starts. Sending it at departure — where the *scrobble* is decided — would be
 * announcing the track that just ended, and the operator would watch their
 * profile run one track behind all evening.
 *
 * So it hangs off the same event as the trail row: `PlayHistoryService.record`,
 * which fires once per transport commit. That is the definition of "now" the
 * rest of Oscine already uses, and reusing it means the two cannot drift into
 * disagreeing about when a track started.
 *
 * It follows from that event, rather than from a threshold, that repeat-one
 * announces each time round — every repeat is a fresh commit and a fresh trail
 * row — and that a skipped track announces once and only once, because it
 * committed once. Neither is special-cased here; both are properties of the
 * event this listens to.
 *
 * ## Why nothing here reports a failure
 *
 * `ScrobbleTarget.nowPlaying` returns `void` by contract and swallows its own
 * failures. This adds no error handling on top, because there is nothing a
 * caller could do: by the time a retry landed the claim would be false, there is
 * no queue for it, and the alternative to silence is a banner about a
 * notification the operator never asked to be told about.
 *
 * What it does guarantee is that nothing propagates. It is called from the
 * play-history write, which is called from an IPC handler, which is on the path
 * of every track change — a rejected promise escaping here would be an
 * unhandled rejection in main every time somebody pressed Next with a flaky
 * connection.
 */

import type { Track } from '@shared/library'
import type { NowPlayingPayload, ScrobbleTarget } from '@shared/scrobble'

export interface NowPlayingAnnouncer {
  /** Tell every connected target. Returns at once; never throws, never rejects. */
  announce(track: Track): void
}

export interface NowPlayingAnnouncerOptions {
  /**
   * Read per announcement, for `ListenScrobbleSink.targets`' reason: an account
   * connected between two tracks should hear about the second one.
   */
  targets(): readonly ScrobbleTarget[]
}

/**
 * A `Track` as a target wants it.
 *
 * `Track` is the display row — the track as it is indexed *now* — and that is
 * the right source here, unlike the scrobble itself: a now-playing is a claim
 * about the present, so the present spelling of the tags is the accurate one.
 * The listen commit snapshots instead, because a scrobble may be sent days
 * after the play it describes.
 */
function payloadFor(track: Track): NowPlayingPayload {
  return {
    artistName: track.artist ?? '',
    title: track.title,
    albumTitle: track.album,
    albumArtistName: track.albumArtist,
    durationSeconds: track.durationSec
  }
}

export function createNowPlayingAnnouncer({
  targets
}: NowPlayingAnnouncerOptions): NowPlayingAnnouncer {
  return {
    announce(track: Track): void {
      // The same rule the outbox applies at enqueue, applied before a request
      // rather than after one: every service keys on artist and title, and a
      // notification missing either is a round trip that can only be refused.
      if (track.artist === null || track.artist.trim() === '') return
      if (track.title.trim() === '') return

      const payload = payloadFor(track)
      for (const target of targets()) {
        if (!target.connection().connected) continue
        // Voided, with a catch that cannot fire under the contract and is here
        // for the implementation that one day forgets it. See the header.
        void target.nowPlaying(payload).catch(() => undefined)
      }
    }
  }
}
