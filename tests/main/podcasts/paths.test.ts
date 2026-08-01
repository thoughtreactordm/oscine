import { describe, expect, it } from 'vitest'
import {
  episodeRelPath,
  podcastDirName,
  resolveEpisodeAbsPath
} from '../../../src/main/podcasts/paths'

describe('podcast paths', () => {
  it('builds POSIX-relative episode paths', () => {
    expect(podcastDirName(7, 'Hello/World?')).toBe('7-hello-world')
    expect(episodeRelPath(7, 'Show', 3, 'Ep One', 'https://cdn.example/a/b.m4a')).toBe(
      '7-show/3-ep-one.m4a'
    )
  })

  it('rejoins under the podcasts root without traversal', () => {
    const abs = resolveEpisodeAbsPath('/data/podcasts', '../escape/x.mp3')
    expect(abs.replace(/\\/g, '/')).toBe('/data/podcasts/escape/x.mp3')
  })
})
