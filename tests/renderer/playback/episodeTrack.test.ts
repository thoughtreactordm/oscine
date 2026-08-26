import { describe, expect, it } from 'vitest'
import { episodeAsTrack } from '../../../src/renderer/playback/episodeTrack'
import { createFixedPlayOrder } from '../../../src/renderer/playback/playOrder'
import {
  episodeIdFromPlaybackTrackId,
  episodePlaybackTrackId,
  type Episode,
  type Podcast
} from '../../../src/shared/podcasts'
import { artworkUrl } from '../../../src/shared/ipc'

const podcast: Podcast = {
  id: 2,
  feedUrl: 'https://example.com/feed.xml',
  title: 'Sample Show',
  author: 'Ada',
  description: null,
  siteUrl: null,
  artwork: {
    small: artworkUrl(null, 'small'),
    large: artworkUrl(null, 'large')
  },
  subscribedAt: new Date(0).toISOString(),
  lastFetchedAt: null,
  lastError: null,
  episodeCount: 1,
  undownloadedCount: 0,
  unplayedCount: 1,
  autoDownload: false,
  keepLast: 3
}

const episode: Episode = {
  id: 9,
  podcastId: 2,
  guid: 'g',
  title: 'Episode Nine',
  description: null,
  pubDate: '2024-06-01T00:00:00.000Z',
  durationMs: 90_000,
  downloadStatus: 'ready',
  played: false,
  progressMs: 0,
  podcastTitle: 'Sample Show',
  podcastArtwork: podcast.artwork
}

describe('episode playback ids', () => {
  it('maps episode ids onto the negative track-id space', () => {
    expect(episodePlaybackTrackId(9)).toBe(-9)
    expect(episodeIdFromPlaybackTrackId(-9)).toBe(9)
    expect(episodeIdFromPlaybackTrackId(9)).toBeNull()
  })
})

describe('episodeAsTrack', () => {
  it('adapts an episode into a Track the transport already understands', () => {
    const track = episodeAsTrack(episode, podcast)
    expect(track.id).toBe(-9)
    expect(track.title).toBe('Episode Nine')
    expect(track.album).toBe('Sample Show')
    expect(track.artist).toBe('Ada')
    expect(track.durationSec).toBe(90)
  })
})

describe('createFixedPlayOrder', () => {
  it('traverses the supplied rows without further IO', async () => {
    const a = episodeAsTrack(episode, podcast)
    const b = episodeAsTrack({ ...episode, id: 10, title: 'Ten' }, podcast)
    const order = createFixedPlayOrder([a, b])
    expect(await order.count()).toBe(2)
    expect(await order.at(0)).toEqual(a)
    expect(await order.at(1)).toEqual(b)
    expect(await order.at(2)).toBeNull()
  })
})
