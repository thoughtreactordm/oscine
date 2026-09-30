import { describe, expect, it } from 'vitest'
import { TAG_FIELDS } from '../../src/shared/tagFields'
import { CLEAR_VALUE, FIELD_CASES } from '../../scripts/lib/writeback-field-cases.mjs'

/**
 * The W16-16 corpus gate runs under plain Node, so it cannot import the TS tag
 * registry and carries its own field table. This pins the two together: a field
 * the registry grows, renames or re-kinds without the gate following would
 * otherwise be admitted on a check that never ran against it (Decision D).
 */
describe('writeback corpus field cases', () => {
  it('mirror the registry one-to-one, in order', () => {
    expect(FIELD_CASES.map((c) => c.key)).toEqual(TAG_FIELDS.map((f) => f.key))
  })

  it.each(TAG_FIELDS.map((field) => [field.key, field] as const))(
    '%s agrees on taglib property, kind and read-only-ness',
    (key, field) => {
      const fieldCase = FIELD_CASES.find((c) => c.key === key)
      expect(fieldCase).toMatchObject({
        taglib: field.taglib,
        kind: field.kind,
        readOnly: field.readOnly
      })
    }
  )

  it('write values the registry would accept', () => {
    for (const field of TAG_FIELDS) {
      const fieldCase = FIELD_CASES.find((c) => c.key === field.key)!
      if (field.kind === 'text') {
        expect(typeof fieldCase.value).toBe('string')
        expect((fieldCase.value as string).length).toBeLessThanOrEqual(field.maxLength)
      } else if (field.kind === 'int') {
        expect(Number.isInteger(fieldCase.value)).toBe(true)
        expect(fieldCase.value).toBeGreaterThanOrEqual(field.min)
        expect(fieldCase.value).toBeLessThanOrEqual(field.max)
      } else if (field.kind === 'bool') {
        // `false` is the clear value, so a set of `false` could not prove anything.
        expect(fieldCase.value).toBe(true)
      }
    }
  })

  it('give every list a distinct, ordered two-entry multi case', () => {
    for (const fieldCase of FIELD_CASES.filter((c) => c.kind === 'list')) {
      const multi = fieldCase.multi ?? []
      expect(multi).toHaveLength(2)
      expect(multi[0]).not.toBe(multi[1])
    }
  })

  it('define a clear value for every editable kind', () => {
    for (const fieldCase of FIELD_CASES.filter((c) => !c.readOnly)) {
      expect(fieldCase.kind in CLEAR_VALUE).toBe(true)
    }
  })
})
