import { describe, expect, it } from 'vitest'
import { creditText, imageInfoUrl, parseImageInfo } from '../../../src/main/wikipedia/commons'
import { entityImageUrl, parseEntityImage } from '../../../src/main/wikipedia/wikidata'

/**
 * W7-13's two remote documents, as functions of a string.
 *
 * The interesting half is not "does it read a well-formed reply". It is the
 * three ways a picture must be refused — a claim with no value, a file that is
 * not an image, a file with no description page to attribute it to — because a
 * refusal that fails open renders somebody's photograph with no credit on it,
 * which is the one failure in this card that is a licence problem rather than a
 * cosmetic one.
 */

const IMAGE_INFO = {
  query: {
    pages: [
      {
        title: 'File:Kurt Cobain 1992.jpg',
        imageinfo: [
          {
            mime: 'image/jpeg',
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Kurt_Cobain_1992.jpg',
            thumburl:
              'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Kurt_Cobain_1992.jpg/640px-Kurt_Cobain_1992.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Kurt_Cobain_1992.jpg',
            extmetadata: {
              Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:P">P. Bergen</a>' },
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
            }
          }
        ]
      }
    ]
  }
}

/** Swaps one field of the fixture without restating the rest of it. */
function withInfo(patch: Record<string, unknown>): unknown {
  const [page] = IMAGE_INFO.query.pages
  return { query: { pages: [{ ...page, imageinfo: [{ ...page.imageinfo[0], ...patch }] }] } }
}

describe('the wikidata image claim', () => {
  it('asks for one property of one entity', () => {
    const url = new URL(entityImageUrl('Q11649'))
    expect(url.searchParams.get('action')).toBe('wbgetclaims')
    expect(url.searchParams.get('entity')).toBe('Q11649')
    expect(url.searchParams.get('property')).toBe('P18')
  })

  it('reads the file name out of a claim', () => {
    const body = {
      claims: {
        P18: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: 'Kurt.jpg' } } }]
      }
    }
    expect(parseEntityImage(body)).toBe('Kurt.jpg')
  })

  it('skips a deprecated claim in favour of the next one', () => {
    const body = {
      claims: {
        P18: [
          {
            rank: 'deprecated',
            mainsnak: { snaktype: 'value', datavalue: { value: 'Wrong.jpg' } }
          },
          { rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: 'Right.jpg' } } }
        ]
      }
    }
    expect(parseEntityImage(body)).toBe('Right.jpg')
  })

  /**
   * `novalue` is Wikidata saying "this item is known to have no image", which is
   * a different statement from "nobody has said" and the same outcome. Reading
   * the snak's absent `datavalue` as anything but nothing would be a crash.
   */
  it('treats a valueless snak as no image', () => {
    const body = { claims: { P18: [{ rank: 'normal', mainsnak: { snaktype: 'novalue' } }] } }
    expect(parseEntityImage(body)).toBeNull()
  })

  it('survives every shape a claims reply is not', () => {
    expect(parseEntityImage(null)).toBeNull()
    expect(parseEntityImage({})).toBeNull()
    expect(parseEntityImage({ claims: [] })).toBeNull()
    expect(parseEntityImage({ claims: { P18: 'Kurt.jpg' } })).toBeNull()
    expect(parseEntityImage({ claims: { P18: [{}] } })).toBeNull()
    expect(
      parseEntityImage({ claims: { P18: [{ mainsnak: { snaktype: 'value', datavalue: {} } }] } })
    ).toBeNull()
  })
})

describe('the commons request', () => {
  it('namespaces the bare file name and asks for a rendered thumbnail', () => {
    const url = new URL(imageInfoUrl('Kurt Cobain 1992.jpg', 640))
    expect(url.host).toBe('commons.wikimedia.org')
    expect(url.searchParams.get('titles')).toBe('File:Kurt Cobain 1992.jpg')
    expect(url.searchParams.get('iiurlwidth')).toBe('640')
    expect(url.searchParams.get('iiprop')).toContain('extmetadata')
  })

  it('filters the metadata block rather than taking all of it', () => {
    const url = new URL(imageInfoUrl('Kurt.jpg'))
    const filter = url.searchParams.get('iiextmetadatafilter')
    expect(filter).toContain('LicenseShortName')
    expect(filter).toContain('Artist')
    // The half-kilobyte of categories and camera settings we never render.
    expect(filter).not.toContain('Categories')
  })
})

describe('reading a commons reply', () => {
  it('takes the thumbnail and the credit together', () => {
    const image = parseImageInfo(IMAGE_INFO)
    expect(image?.thumbUrl).toContain('640px-Kurt_Cobain_1992.jpg')
    expect(image?.credit).toEqual({
      artist: 'P. Bergen',
      attribution: null,
      licence: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      descriptionUrl: 'https://commons.wikimedia.org/wiki/File:Kurt_Cobain_1992.jpg'
    })
  })

  it('refuses a file it cannot attribute', () => {
    // No description page is no link to the terms, and the short name alone is
    // not attribution. Better no picture than an unattributed one.
    expect(parseImageInfo(withInfo({ descriptionurl: undefined }))).toBeNull()
  })

  it('refuses a claim that does not point at an image', () => {
    expect(parseImageInfo(withInfo({ mime: 'application/pdf' }))).toBeNull()
  })

  it('refuses a file commons could not render a thumbnail for', () => {
    // The original is not a substitute. It is the multi-megabyte file the
    // thumbnail request exists to avoid downloading.
    expect(parseImageInfo(withInfo({ thumburl: undefined }))).toBeNull()
  })

  it('reads a file whose metadata block is missing entirely', () => {
    // Rare and legal: the picture is usable, and the file page carries the
    // terms. Everything nullable comes back null rather than throwing.
    const image = parseImageInfo(withInfo({ extmetadata: undefined }))
    expect(image?.credit.artist).toBeNull()
    expect(image?.credit.licence).toBeNull()
    expect(image?.credit.descriptionUrl).toContain('commons.wikimedia.org')
  })

  it('survives a missing page and every shape a reply is not', () => {
    expect(parseImageInfo({ query: { pages: [{ missing: true }] } })).toBeNull()
    expect(parseImageInfo(null)).toBeNull()
    expect(parseImageInfo({})).toBeNull()
    expect(parseImageInfo({ query: { pages: [] } })).toBeNull()
    expect(parseImageInfo({ query: { pages: [{ imageinfo: [] }] } })).toBeNull()
  })
})

describe('credit text', () => {
  it('strips the anchor commons wraps an author in', () => {
    expect(creditText('<a href="/wiki/User:P" title="User:P">P. Bergen</a>')).toBe('P. Bergen')
  })

  it('collapses a multi-line credit onto one line', () => {
    expect(creditText('Own work\n\nby the uploader')).toBe('Own work by the uploader')
  })

  it('decodes the entities that cannot become markup', () => {
    expect(creditText('Smith &amp; Jones')).toBe('Smith & Jones')
    expect(creditText('The &quot;Nevermind&quot; shoot')).toBe('The "Nevermind" shoot')
  })

  /**
   * The ordering guarantee, stated as a test because it is the only thing
   * standing between a doubly-encoded field and a tag this function has just
   * removed. `&amp;lt;` must come out as the four visible characters `&lt;`.
   */
  it('cannot reconstruct a tag out of a double encoding', () => {
    expect(creditText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;')
    expect(creditText('&amp;lt;script&amp;gt;')).not.toContain('<')
  })

  it('is null for a field that was only markup', () => {
    expect(creditText('<span></span>')).toBeNull()
    expect(creditText('   ')).toBeNull()
  })
})
