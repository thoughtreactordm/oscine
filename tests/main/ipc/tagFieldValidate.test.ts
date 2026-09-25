import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OscineError } from '@shared/errors'
import { MAX_OVERRIDE_TRACKS } from '@shared/overrides'
import {
  TAG_LIST_MAX_ENTRIES,
  TAG_LONG_TEXT_MAX_LENGTH,
  TAG_TEXT_MAX_LENGTH,
  tagField,
  type TagFieldDef
} from '@shared/tagFields'
import {
  assertRevertTagOverridesRequest,
  assertSetTagOverridesRequest,
  assertTagFieldValue
} from '../../../src/main/ipc/validate'

/**
 * Generic tag-field validation — **W16-15**. Every rule is driven by the
 * registry entry: the kind picks the shape, the entry carries the bounds, and
 * admission decides whether a key is offered at all.
 */

function field(key: string): TagFieldDef {
  const def = tagField(key)
  if (def === undefined) throw new Error(`no registry field ${key}`)
  return def
}

describe('assertTagFieldValue', () => {
  it('accepts null as the clear intent for every kind', () => {
    for (const key of ['conductor', 'bpm', 'compilation', 'composers']) {
      expect(assertTagFieldValue(field(key), null)).toBeNull()
    }
  })

  it('checks text against the field’s own length cap', () => {
    expect(assertTagFieldValue(field('conductor'), 'Karajan')).toBe('Karajan')
    expect(() =>
      assertTagFieldValue(field('conductor'), 'x'.repeat(TAG_TEXT_MAX_LENGTH + 1))
    ).toThrow(OscineError)
    const lyrics = 'la '.repeat(10_000)
    expect(assertTagFieldValue(field('lyrics'), lyrics)).toBe(lyrics)
    expect(() =>
      assertTagFieldValue(field('lyrics'), 'x'.repeat(TAG_LONG_TEXT_MAX_LENGTH + 1))
    ).toThrow(OscineError)
    expect(() => assertTagFieldValue(field('conductor'), 7)).toThrow(OscineError)
  })

  it('normalises empty text to a clear', () => {
    expect(assertTagFieldValue(field('conductor'), '')).toBeNull()
  })

  it('checks int range per field', () => {
    expect(assertTagFieldValue(field('bpm'), 128)).toBe(128)
    expect(assertTagFieldValue(field('trackTotal'), 9999)).toBe(9999)
    for (const bad of [0, -1, 1000, 12.5, '128', Number.NaN]) {
      expect(() => assertTagFieldValue(field('bpm'), bad), String(bad)).toThrow(OscineError)
    }
    expect(() => assertTagFieldValue(field('discTotal'), 1000)).toThrow(OscineError)
  })

  it('checks bool strictly', () => {
    expect(assertTagFieldValue(field('compilation'), true)).toBe(true)
    expect(assertTagFieldValue(field('compilation'), false)).toBe(false)
    expect(() => assertTagFieldValue(field('compilation'), 1)).toThrow(OscineError)
    expect(() => assertTagFieldValue(field('compilation'), 'true')).toThrow(OscineError)
  })

  it('checks a list of non-empty strings, and treats an empty list as a clear', () => {
    expect(assertTagFieldValue(field('composers'), ['Bach', ' Handel'])).toEqual([
      'Bach',
      ' Handel'
    ])
    expect(assertTagFieldValue(field('composers'), [])).toBeNull()
    expect(() => assertTagFieldValue(field('composers'), ['Bach', ''])).toThrow(OscineError)
    expect(() => assertTagFieldValue(field('composers'), ['  '])).toThrow(OscineError)
    expect(() => assertTagFieldValue(field('composers'), ['Bach', 3])).toThrow(OscineError)
    expect(() => assertTagFieldValue(field('composers'), 'Bach')).toThrow(OscineError)
    expect(() =>
      assertTagFieldValue(
        field('composers'),
        Array.from({ length: TAG_LIST_MAX_ENTRIES + 1 }, (_, i) => `c${i}`)
      )
    ).toThrow(OscineError)
    expect(() =>
      assertTagFieldValue(field('composers'), ['x'.repeat(TAG_TEXT_MAX_LENGTH + 1)])
    ).toThrow(OscineError)
  })

  it('refuses a value for a read-only field', () => {
    expect(() => assertTagFieldValue(field('replayGainTrackGain'), -6.5)).toThrow(OscineError)
  })
})

describe('assertSetTagOverridesRequest', () => {
  // Nothing is admitted until W16-16's corpus gate; admit a few for the duration.
  const admittedForTest = ['composers', 'bpm', 'compilation', 'conductor']
  function setAdmitted(value: boolean): void {
    for (const key of admittedForTest) (field(key) as { admitted: boolean }).admitted = value
  }
  beforeEach(() => setAdmitted(true))
  afterEach(() => setAdmitted(false))

  it('accepts admitted fields and validates each value by kind', () => {
    expect(
      assertSetTagOverridesRequest({
        trackIds: [1, 2],
        patch: { composers: ['Bach'], bpm: 90, compilation: true, conductor: null }
      })
    ).toEqual({
      trackIds: [1, 2],
      patch: { composers: ['Bach'], bpm: 90, compilation: true, conductor: null }
    })
    expect(() => assertSetTagOverridesRequest({ trackIds: [1], patch: { bpm: 'fast' } })).toThrow(
      OscineError
    )
  })

  it('refuses a field the corpus has not admitted', () => {
    expect(field('publisher').admitted).toBe(false)
    expect(() =>
      assertSetTagOverridesRequest({ trackIds: [1], patch: { publisher: 'Deutsche Grammophon' } })
    ).toThrow(OscineError)
  })

  it('refuses read-only, grouped and unknown keys', () => {
    const replayGain = field('replayGainTrackGain') as { admitted: boolean }
    replayGain.admitted = true
    try {
      for (const patch of [{ replayGainTrackGain: -6 }, { title: 'x' }, { amazonId: 'B00' }]) {
        expect(() => assertSetTagOverridesRequest({ trackIds: [1], patch })).toThrow(OscineError)
      }
    } finally {
      replayGain.admitted = false
    }
  })

  it('refuses an empty patch, extra keys and an unbounded track set', () => {
    expect(() => assertSetTagOverridesRequest({ trackIds: [1], patch: {} })).toThrow(OscineError)
    expect(() =>
      assertSetTagOverridesRequest({ trackIds: [1], patch: { bpm: 90 }, extra: 1 })
    ).toThrow(OscineError)
    expect(() => assertSetTagOverridesRequest({ trackIds: [], patch: { bpm: 90 } })).toThrow(
      OscineError
    )
    expect(() =>
      assertSetTagOverridesRequest({
        trackIds: Array.from({ length: MAX_OVERRIDE_TRACKS + 1 }, (_, i) => i + 1),
        patch: { bpm: 90 }
      })
    ).toThrow(OscineError)
  })
})

describe('assertRevertTagOverridesRequest', () => {
  it('accepts any registry key, admitted or not, and dedupes', () => {
    expect(
      assertRevertTagOverridesRequest({ trackIds: [3], fields: ['publisher', 'bpm', 'bpm'] })
    ).toEqual({ trackIds: [3], fields: ['publisher', 'bpm'] })
  })

  it('refuses unknown keys and an empty field list', () => {
    expect(() => assertRevertTagOverridesRequest({ trackIds: [3], fields: ['title'] })).toThrow(
      OscineError
    )
    expect(() => assertRevertTagOverridesRequest({ trackIds: [3], fields: [7] })).toThrow(
      OscineError
    )
    expect(() => assertRevertTagOverridesRequest({ trackIds: [3], fields: [] })).toThrow(
      OscineError
    )
  })
})
