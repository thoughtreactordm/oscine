import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Star is playlists and artists; heart is tracks — **D24**, product rule 6,
 * "never the same glyph for both".
 *
 * A property of the source tree rather than a mounted component, for
 * `noRemoteHtml`'s reason: the rule is absolute across surfaces, and grepping
 * the tree proves the next favorite affordance keeps it too. The failure worth
 * catching is a refactor that reaches for `i-tabler-heart` on the playlist
 * header, or drops the star onto a track row — both of which read fine in one
 * component and break the rule across the app.
 */

const RENDERER = join(__dirname, '../../../src/renderer')
const read = (rel: string): string => readFileSync(join(RENDERER, rel), 'utf8')

describe('FavoriteStar', () => {
  it('draws the star and never the heart', () => {
    const star = read('panels/FavoriteStar.vue')
    expect(star).toContain('i-tabler-star-filled')
    expect(star).toContain('i-tabler-star')
    // The glyph, not the prose: the doc comment names the heart to contrast with it.
    expect(star).not.toContain('i-tabler-heart')
  })
})

describe('the star is on playlist and artist surfaces', () => {
  it('sits on the playlist contents header', () => {
    const contents = read('panels/PlaylistContents.vue')
    expect(contents).toContain('FavoriteStar')
    expect(contents).toContain('usePlaylistFavorites')
  })

  it('sits on the artist identity header, using the real artist-favorite store', () => {
    const header = read('panels/tunedeck/ArtistIdentityHeader.vue')
    expect(header).toContain('FavoriteStar')
    // The star store, not the track-by-artist `artistFavorites` deck pane.
    expect(header).toContain("from '@renderer/stores/artistStars'")
    expect(header).toContain('useArtistFavorites')
  })
})

describe('the track heart is untouched', () => {
  it('still draws a heart in the song list, and no star', () => {
    const list = read('panels/TrackList.vue')
    expect(list).toContain('i-tabler-heart-filled')
    expect(list).toContain('i-tabler-heart')
    expect(list).not.toContain('i-tabler-star')
  })
})
