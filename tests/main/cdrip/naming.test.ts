import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RIP_NAME_TEMPLATE,
  RIP_DESTINATION_ROOT_KEY,
  RIP_NAME_TEMPLATE_KEY,
  RIP_VERIFY_KEY,
  renderRipPath,
  type RipNameFields
} from '@shared/cdrip'
import { MAX_PATH_COMPONENT_BYTES } from '@shared/pathSanitize'
import { getSetting } from '@shared/settings'

const geogaddi: RipNameFields = {
  albumartist: 'Boards of Canada',
  artist: 'Boards of Canada',
  album: 'Geogaddi',
  title: 'Music Is Math',
  track: 3,
  disc: 1,
  discCount: 1,
  year: 2002
}

function render(fields: Partial<RipNameFields> = {}, template = DEFAULT_RIP_NAME_TEMPLATE): string {
  return renderRipPath(template, { ...geogaddi, ...fields })
}

const utf8 = new TextEncoder()

describe('rip naming settings', () => {
  it('registers the default template on the library cascade', () => {
    const template = getSetting(RIP_NAME_TEMPLATE_KEY)
    expect(template?.default).toBe(DEFAULT_RIP_NAME_TEMPLATE)
    expect(template?.category).toBe('library')
    expect(template?.portable).toBe(true)

    const destination = getSetting(RIP_DESTINATION_ROOT_KEY)
    expect(destination?.default).toBe('')
    expect(destination?.portable).toBe(false)
    expect(destination?.control).toEqual({ kind: 'path', select: 'directory' })
  })

  it('registers verify off by default and says it doubles rip time', () => {
    const verify = getSetting(RIP_VERIFY_KEY)
    expect(verify?.default).toBe(false)
    expect(verify?.help).toMatch(/doubles rip time/i)
  })
})

describe('renderRipPath', () => {
  it('renders every token and the default template without an extension', () => {
    expect(render()).toBe('Boards of Canada/Geogaddi (2002)/03 Music Is Math')
    expect(
      render(
        { disc: 1, discCount: 2 },
        '{albumartist}/{artist}/{album}/{title}/{track}/{disc}/{year}'
      )
    ).toBe('Boards of Canada/Boards of Canada/Geogaddi/Music Is Math/3/1/2002')
  })

  it('zero-pads numerics with a :02-style width', () => {
    expect(render({ track: 3, disc: 2, discCount: 2 }, '{disc:02}-{track:02}')).toBe('02-03')
    expect(render({ year: 9 }, '{year:04}')).toBe('0009')
  })

  it('leaves an unknown token literal and does not throw on a malformed {unclosed', () => {
    expect(render({}, '{album}/{foo}/{title}')).toBe('Geogaddi/{foo}/Music Is Math')
    expect(render({}, '{album}/{unclosed')).toBe('Geogaddi/{unclosed')
  })

  it('substitutes stated placeholders for empty name tokens', () => {
    expect(
      render(
        { albumartist: '', artist: '   ', album: '', title: '' },
        '{albumartist}/{album}/{title}'
      )
    ).toBe('Unknown Artist/Unknown Album/Unknown Title')
  })

  it('collapses {disc} and its adjacent separator on a single-disc release', () => {
    expect(render()).toBe('Boards of Canada/Geogaddi (2002)/03 Music Is Math')
    expect(render({}, '{disc} - {track:02} {title}')).toBe('03 Music Is Math')
    expect(render({}, '{track:02}-{disc} {title}')).toBe('03 Music Is Math')
    expect(render({}, '{album}/{disc}/{title}')).toBe('Geogaddi/Music Is Math')
  })

  it('keeps {disc} on a multi-disc release', () => {
    expect(render({ disc: 2, discCount: 2 })).toBe(
      'Boards of Canada/Geogaddi (2002)/2-03 Music Is Math'
    )
  })

  it('sanitizes per component so a slash in a title cannot split the tree', () => {
    expect(render({ album: 'AC/DC: Back in Black' }, '{album}/{title}')).toBe(
      'AC_DC_ Back in Black/Music Is Math'
    )
  })

  it.each(['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\u0001'])(
    'replaces reserved character %j rather than dropping the segment',
    (char) => {
      expect(render({ title: `x${char}y` }, '{title}')).toBe('x_y')
    }
  )

  it('does not emit an empty segment when a title is entirely reserved characters', () => {
    expect(render({ title: '***' }, '{title}')).toBe('___')
    expect(render({ title: '///' }, '{album}/{title}')).toBe('Geogaddi/___')
  })

  it('strips a trailing dot and a trailing space', () => {
    expect(render({ album: 'Geogaddi.' }, '{album}')).toBe('Geogaddi')
    expect(render({ album: 'Geogaddi ' }, '{album}')).toBe('Geogaddi')
  })

  it.each(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'lpt9', 'con'])(
    'prefixes a Windows reserved device name (%s)',
    (name) => {
      expect(render({ album: name }, '{album}')).toBe(`_${name}`)
    }
  )

  it('does not treat COM10 as a reserved device name', () => {
    expect(render({ album: 'COM10' }, '{album}')).toBe('COM10')
  })

  it('refuses a .. component rather than letting it escape the destination', () => {
    expect(render({}, '{album}/../{title}')).toBe('Geogaddi/_/Music Is Math')
  })

  it('truncates a 300-byte UTF-8 title on a grapheme boundary', () => {
    const title = 'é'.repeat(150)
    expect(utf8.encode(title).length).toBe(300)
    const rendered = render({ title }, '{title}')
    const bytes = utf8.encode(rendered)
    expect(bytes.length).toBeLessThanOrEqual(MAX_PATH_COMPONENT_BYTES)
    expect(bytes.length % 2).toBe(0)
    expect(rendered).toBe('é'.repeat(bytes.length / 2))
  })

  it('drops a grapheme that would not fit rather than splitting it', () => {
    const flag = '🏴󠁧󠁢󠁷󠁬󠁳󠁿'
    const title = `${'a'.repeat(250)}${flag}`
    const rendered = render({ title }, '{title}')
    expect(rendered.endsWith(flag)).toBe(false)
    expect(rendered).toBe('a'.repeat(250))
    expect(utf8.encode(rendered).length).toBe(250)
  })
})
