import { describe, expect, it } from 'vitest'
import { parsePaletteQuery, queryReachesMain } from '../../../src/renderer/shell/paletteMode'

/**
 * The prefix grammar, D21. A wrong parse here is a query sent to the wrong group
 * or a `#` in a song title read as a mode — both invisible until the palette is
 * open and wrong.
 */

describe('parsePaletteQuery', () => {
  it('reads each prefix into its mode and drops the prefix from the text', () => {
    expect(parsePaletteQuery('>play all')).toEqual({ mode: 'action', text: 'play all' })
    expect(parsePaletteQuery('@radiohead')).toEqual({ mode: 'artist', text: 'radiohead' })
    expect(parsePaletteQuery('#roadtrip')).toEqual({ mode: 'playlist', text: 'roadtrip' })
    expect(parsePaletteQuery('/theme')).toEqual({ mode: 'setting', text: 'theme' })
  })

  it('is blended with no prefix', () => {
    expect(parsePaletteQuery('kid a')).toEqual({ mode: 'blended', text: 'kid a' })
  })

  it('only treats the first character as a prefix', () => {
    // A hash mid-title is text, not a mode switch.
    expect(parsePaletteQuery('song #2')).toEqual({ mode: 'blended', text: 'song #2' })
  })

  it('trims the ends of the text', () => {
    expect(parsePaletteQuery('@  radiohead  ')).toEqual({ mode: 'artist', text: 'radiohead' })
    expect(parsePaletteQuery('  kid a ')).toEqual({ mode: 'blended', text: 'kid a' })
  })

  it('handles a bare prefix as an empty query in that mode', () => {
    expect(parsePaletteQuery('@')).toEqual({ mode: 'artist', text: '' })
  })
})

describe('queryReachesMain', () => {
  it('sends only the library modes across the wire', () => {
    expect(queryReachesMain('blended')).toBe(true)
    expect(queryReachesMain('artist')).toBe(true)
    expect(queryReachesMain('playlist')).toBe(true)
  })

  it('keeps action and setting in the renderer', () => {
    // Their groups are the command and settings registries, not the library.
    expect(queryReachesMain('action')).toBe(false)
    expect(queryReachesMain('setting')).toBe(false)
  })
})
