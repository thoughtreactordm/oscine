import { describe, expect, it } from 'vitest'
import { parseItunesDuration, parsePodcastRss } from '../../../src/main/podcasts/rss'

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Sample Show</title>
    <link>https://example.com/show</link>
    <description><![CDATA[A <b>fine</b> show.]]></description>
    <itunes:author>Ada Example</itunes:author>
    <itunes:image href="https://example.com/art.jpg" />
    <item>
      <title>Episode One</title>
      <guid>ep-1</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <itunes:duration>1:02:03</itunes:duration>
      <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="12345" />
      <description>First episode.</description>
    </item>
    <item>
      <title>Episode Two</title>
      <guid isPermaLink="false">ep-2</guid>
      <itunes:duration>90</itunes:duration>
      <enclosure url="https://cdn.example.com/ep2.mp3" length="99" />
    </item>
    <item>
      <title>No audio</title>
      <guid>ep-skip</guid>
    </item>
  </channel>
</rss>`

describe('parsePodcastRss', () => {
  it('extracts channel metadata and enclosure-backed episodes', () => {
    const feed = parsePodcastRss(SAMPLE)
    expect(feed.title).toBe('Sample Show')
    expect(feed.author).toBe('Ada Example')
    expect(feed.description).toBe('A fine show.')
    expect(feed.siteUrl).toBe('https://example.com/show')
    expect(feed.artworkUrl).toBe('https://example.com/art.jpg')
    expect(feed.episodes).toHaveLength(2)
    expect(feed.episodes[0]).toMatchObject({
      guid: 'ep-1',
      title: 'Episode One',
      enclosureUrl: 'https://cdn.example.com/ep1.mp3',
      enclosureType: 'audio/mpeg',
      enclosureSize: 12345,
      durationMs: (1 * 3600 + 2 * 60 + 3) * 1000
    })
    expect(feed.episodes[0]?.pubDateMs).toBe(Date.parse('Mon, 01 Jan 2024 12:00:00 GMT'))
    expect(feed.episodes[1]?.durationMs).toBe(90_000)
  })

  it('rejects feeds without a channel or enclosures', () => {
    expect(() => parsePodcastRss('<rss></rss>')).toThrow(/channel/i)
    expect(() => parsePodcastRss('<rss><channel><title>Empty</title></channel></rss>')).toThrow(
      /episodes/i
    )
  })
})

describe('parseItunesDuration', () => {
  it('accepts seconds and clock forms', () => {
    expect(parseItunesDuration('125')).toBe(125_000)
    expect(parseItunesDuration('3:05')).toBe((3 * 60 + 5) * 1000)
    expect(parseItunesDuration('1:02:03')).toBe((3600 + 120 + 3) * 1000)
    expect(parseItunesDuration('')).toBeNull()
    expect(parseItunesDuration(null)).toBeNull()
  })
})
