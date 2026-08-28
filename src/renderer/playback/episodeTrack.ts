import type { Track } from '@shared/library'
import { episodePlaybackTrackId, type Episode, type Podcast } from '@shared/podcasts'

/**
 * Adapt a downloaded episode into the `Track` shape Now Playing and the
 * scheduler already understand.
 *
 * `id` is the negative playback id (see `episodePlaybackTrackId`); `rootId` is
 * 0 because episodes are not library-rooted. Display fields map show → album /
 * album artist so the transport card reads as a podcast rather than a blank.
 */
export function episodeAsTrack(episode: Episode, podcast: Podcast): Track {
  return {
    id: episodePlaybackTrackId(episode.id),
    rootId: 0,
    title: episode.title,
    artist: podcast.author,
    album: podcast.title,
    albumArtist: podcast.author,
    trackNo: null,
    discNo: null,
    year: episode.pubDate ? new Date(episode.pubDate).getFullYear() : null,
    durationSec: episode.durationMs === null ? null : episode.durationMs / 1000,
    codec: null,
    encodedBytes: 0,
    sampleRateHz: null,
    channels: null,
    bitDepth: null,
    // Zero and never, always. An episode has no row in `tracks` for a counter to
    // cache and no row in `listens` to derive one from — W9 keeps its own play
    // state on the episode. Reporting anything else here would put a podcast in
    // a chart that is about the music library.
    playCount: 0,
    lastPlayedAt: null,
    // Never, for the same reason and one more: `track_favorites` references
    // `tracks`, and an episode has no row there to reference. The heart column
    // and the transport's heart both read this and both draw nothing, which is
    // the correct answer until W9 decides what favoriting an episode means.
    favorite: false,
    modified: false,
    artwork: podcast.artwork,
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}
