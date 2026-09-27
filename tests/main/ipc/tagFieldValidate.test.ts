import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OscineError } from '@shared/errors'
import { MAX_OVERRIDE_TRACKS } from '@shared/overrides'
import {
  MAX_TAG_FIELD_PREFILL_TRACKS,
  TAG_LIST_MAX_ENTRIES,
  TAG_LONG_TEXT_MAX_LENGTH,
  TAG_TEXT_MAX_LENGTH,
  tagField,
  type TagFieldDef
} from '@shared/tagFields'
import {
  assertRevertTagOverridesRequest,
  assertSetTagOverridesRequest,
  assertTagFieldEditStateRequest,
  assertTagFieldValue,
  assertWritebackApplyRequest
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
  // Admission follows the W16-16 corpus gate; pin the states these tests rely on
  // and restore the registry's own afterwards, whatever the gate has admitted.
  const pinned: Record<string, boolean> = {
    composers: true,
    bpm: true,
    compilation: true,
    conductor: true,
    publisher: false
  }
  const original = new Map<string, boolean>()
  beforeEach(() => {
    for (const [key, admitted] of Object.entries(pinned)) {
      const entry = field(key) as { admitted: boolean }
      original.set(key, entry.admitted)
      entry.admitted = admitted
    }
  })
  afterEach(() => {
    for (const [key, admitted] of original)
      (field(key) as { admitted: boolean }).admitted = admitted
  })

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
    expect(field('replayGainTrackGain').admitted).toBe(true)
    for (const patch of [{ replayGainTrackGain: -6 }, { title: 'x' }, { amazonId: 'B00' }]) {
      expect(() => assertSetTagOverridesRequest({ trackIds: [1], patch })).toThrow(OscineError)
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

describe('assertTagFieldEditStateRequest (W16-17)', () => {
  it('accepts a track set up to the prefill bound', () => {
    expect(assertTagFieldEditStateRequest({ trackIds: [1, 2] })).toEqual({ trackIds: [1, 2] })
  })

  it('refuses a batch past the bound, since every track is a file read', () => {
    const trackIds = Array.from({ length: MAX_TAG_FIELD_PREFILL_TRACKS + 1 }, (_, i) => i + 1)
    expect(() => assertTagFieldEditStateRequest({ trackIds })).toThrow(OscineError)
  })
})

describe('write-back selections name generic keys (W16-17)', () => {
  it('accepts grouped and registry keys together', () => {
    expect(
      assertWritebackApplyRequest({
        selections: [{ trackId: 1, fields: ['title', 'conductor', 'composers'] }]
      })
    ).toEqual({ selections: [{ trackId: 1, fields: ['title', 'conductor', 'composers'] }] })
  })

  it('accepts a held key at the boundary — the flush refuses it per file', () => {
    expect(
      assertWritebackApplyRequest({ selections: [{ trackId: 1, fields: ['comment'] }] })
    ).toEqual({ selections: [{ trackId: 1, fields: ['comment'] }] })
  })

  it('refuses a key that is neither', () => {
    expect(() =>
      assertWritebackApplyRequest({ selections: [{ trackId: 1, fields: ['notAField'] }] })
    ).toThrow(OscineError)
  })
})
