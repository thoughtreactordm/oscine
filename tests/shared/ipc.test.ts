import { describe, expect, it } from 'vitest'
import {
  artworkUrl,
  CATALOG_ARTWORK_HOST,
  catalogArtworkUrl,
  hasArtwork,
  isCatalogArtworkHost,
  TRACK_SCHEME
} from '@shared/ipc'

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

/**
 * The allowlist is the whole point of this route: main will fetch whatever
 * survives it, so the tests that matter are the ones about what does not.
 */
describe('catalogue artwork routes', () => {
  const REMOTE = 'https://is1-ssl.mzstatic.com/image/thumb/abc/600x600bb.jpg'

  it('re-addresses an Apple CDN thumbnail through the custom protocol', () => {
    expect(catalogArtworkUrl(REMOTE)).toBe(
      `${TRACK_SCHEME}://${CATALOG_ARTWORK_HOST}/?u=${encodeURIComponent(REMOTE)}`
    )
  })

  it('survives a query string in the remote address', () => {
    const withQuery = `${REMOTE}?w=600&f=jpg`
    const route = catalogArtworkUrl(withQuery)
    expect(new URL(route!).searchParams.get('u')).toBe(withQuery)
  })

  it('refuses a host that merely ends in the allowlisted name', () => {
    expect(catalogArtworkUrl('https://notmzstatic.com/x.jpg')).toBeNull()
    expect(catalogArtworkUrl('https://mzstatic.com.evil.test/x.jpg')).toBeNull()
    expect(isCatalogArtworkHost('notmzstatic.com')).toBe(false)
    expect(isCatalogArtworkHost('mzstatic.com')).toBe(true)
    expect(isCatalogArtworkHost('is1-ssl.mzstatic.com')).toBe(true)
  })

  it('refuses anything that is not https', () => {
    expect(catalogArtworkUrl('http://is1-ssl.mzstatic.com/x.jpg')).toBeNull()
    expect(catalogArtworkUrl('file:///etc/passwd')).toBeNull()
    expect(catalogArtworkUrl('javascript:alert(1)')).toBeNull()
  })

  it('is null for a missing or unparseable address', () => {
    expect(catalogArtworkUrl(null)).toBeNull()
    expect(catalogArtworkUrl(undefined)).toBeNull()
    expect(catalogArtworkUrl('')).toBeNull()
    expect(catalogArtworkUrl('not a url')).toBeNull()
  })
})
