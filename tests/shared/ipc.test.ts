import { describe, expect, it } from 'vitest'
import { artworkUrl, hasArtwork, TRACK_SCHEME } from '@shared/ipc'

const HASH = 'a'.repeat(64)

describe('artwork routes', () => {
  it('addresses a cover by hash and variant', () => {
    expect(artworkUrl(HASH, 'small')).toBe(`${TRACK_SCHEME}://artwork/${HASH}/small`)
    expect(artworkUrl(HASH, 'large')).toBe(`${TRACK_SCHEME}://artwork/${HASH}/large`)
  })

  it('routes a coverless album at the placeholder', () => {
    expect(artworkUrl(null, 'large')).toBe(`${TRACK_SCHEME}://artwork/missing/large`)
  })

  it('distinguishes real cover art from the placeholder', () => {
    expect(hasArtwork(artworkUrl(HASH, 'large'))).toBe(true)
    expect(hasArtwork(artworkUrl(HASH, 'small'))).toBe(true)
    expect(hasArtwork(artworkUrl(null, 'large'))).toBe(false)
    expect(hasArtwork(artworkUrl(null, 'small'))).toBe(false)
  })
})
