import { describe, expect, it } from 'vitest'
import { parseOpml } from '../../../src/main/podcasts/opml'

describe('parseOpml', () => {
  it('collects nested outline xmlUrl feeds', () => {
    const outlines = parseOpml(`<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="News">
      <outline text="Daily" title="Daily News" type="rss" xmlUrl="https://a.example/feed.xml" />
    </outline>
    <outline text="Tech" xmlUrl="https://b.example/rss" xmlurl="https://ignored.example" />
    <outline text="Folder only" />
  </body>
</opml>`)
    expect(outlines).toEqual([
      { title: 'Daily News', feedUrl: 'https://a.example/feed.xml' },
      { title: 'Tech', feedUrl: 'https://b.example/rss' }
    ])
  })
})
