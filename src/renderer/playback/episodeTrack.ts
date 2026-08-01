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
    artwork: podcast.artwork,
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}
