import type { ArtistImageCredit } from '@shared/artistImage'
import { describe, expect, it } from 'vitest'
import { describeCredit } from '../../../src/renderer/panels/tunedeck/imageCredit'

/**
 * The attribution wording, which is the part of W7-13 with an obligation behind
 * it rather than a preference.
 *
 * Commons files carry whichever of these fields their uploader filled in, and
 * the failure mode is silent: a credit that renders as an empty string, or one
 * that quietly drops the photographer because the licence field was missing,
 * looks fine on screen and is a licence breach. So every combination gets a
 * case, including the one where Commons recorded nothing at all.
 */

const DESCRIPTION = 'https://commons.wikimedia.org/wiki/File:Kurt.jpg'

function credit(patch: Partial<ArtistImageCredit> = {}): ArtistImageCredit {
  return {
    artist: null,
    attribution: null,
    licence: null,
    licenceUrl: null,
    descriptionUrl: DESCRIPTION,
    ...patch
  }
}

describe('the commons credit', () => {
  it('names the photographer and the licence when it has both', () => {
    const described = describeCredit(credit({ artist: 'P. Bergen', licence: 'CC BY-SA 4.0' }))
    expect(described.summary).toBe('Photo: P. Bergen · CC BY-SA 4.0')
    expect(described.name).toBe('P. Bergen')
  })

  /**
   * The rule with the most force behind it. A photographer who wrote their own
   * attribution line stated the form their licence obliges, and preferring the
   * bare author field to it would be substituting our tidiness for their terms.
   */
  it('prefers the uploader’s required attribution over the author field', () => {
    const described = describeCredit(
      credit({ artist: 'P. Bergen', attribution: 'Photo by A. N. Other / example.com' })
    )
    expect(described.name).toBe('Photo by A. N. Other / example.com')
    expect(described.summary).toContain('A. N. Other')
    expect(described.summary).not.toContain('Bergen')
  })

  it('says what it knows when only one of the two is recorded', () => {
    expect(describeCredit(credit({ artist: 'P. Bergen' })).summary).toBe('Photo: P. Bergen')
    expect(describeCredit(credit({ licence: 'Public domain' })).summary).toBe(
      'Photo · Public domain'
    )
  })

  /**
   * An old upload whose metadata nobody ever filled in. The file still came from
   * Commons, and saying so is the minimum honest statement about a picture on
   * screen — an empty string here would be a credit that renders as nothing.
   */
  it('still says where the picture came from when commons recorded nothing', () => {
    const described = describeCredit(credit())
    expect(described.summary).toBe('Photo from Wikimedia Commons')
    expect(described.name).toBeNull()
  })

  it('always carries the file page, whatever else is missing', () => {
    expect(describeCredit(credit()).descriptionUrl).toBe(DESCRIPTION)
    expect(describeCredit(credit({ licence: 'CC BY 4.0' })).descriptionUrl).toBe(DESCRIPTION)
  })

  it('passes the licence link through untouched for the anchor to use', () => {
    const url = 'https://creativecommons.org/licenses/by-sa/4.0/'
    expect(describeCredit(credit({ licence: 'CC BY-SA 4.0', licenceUrl: url })).licenceUrl).toBe(
      url
    )
  })
})
