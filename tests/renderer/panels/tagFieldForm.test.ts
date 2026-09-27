import { describe, expect, it } from 'vitest'
import type { OverrideFieldState } from '../../../src/shared/overrides'
import {
  TAG_FIELDS,
  tagField,
  type TagFieldDef,
  type TagFieldValue
} from '../../../src/shared/tagFields'
import {
  buildTagFieldSave,
  buildTagInfoSections,
  formValue,
  formValues,
  formatTagValue,
  isMultiline,
  tagFieldEdit,
  tagFieldSections,
  tagFormDirty
} from '../../../src/renderer/panels/tagFieldForm'

/**
 * The metadata editor's "All fields" model — W16-18, the pure half. Sections
 * from the registry, cells to form values, and the form back to a patch.
 */

function def(key: string): TagFieldDef {
  const field = tagField(key)
  if (field === undefined) throw new Error(`no registry field ${key}`)
  return field
}

function cell(
  value: TagFieldValue | null,
  flags: Partial<{ mixed: boolean; overridden: boolean }> = {}
): OverrideFieldState<TagFieldValue> {
  return { value, mixed: flags.mixed ?? false, overridden: flags.overridden ?? false }
}

describe('tagFieldSections', () => {
  it('groups admitted fields in group order and skips held ones', () => {
    const sections = tagFieldSections()
    expect(sections.map((section) => section.group)).toEqual([
      'credits',
      'numbering',
      'release',
      'content',
      'sorting',
      'advanced',
      'readOnly'
    ])
    const keys = sections.flatMap((section) => section.fields.map((field) => field.key))
    expect(keys).toContain('composers')
    expect(keys).toContain('replayGainTrackGain')
    for (const field of TAG_FIELDS) {
      expect(keys.includes(field.key)).toBe(field.admitted)
    }
  })

  it('drops a group left with no admitted field', () => {
    const only: TagFieldDef = { ...def('conductor'), admitted: false }
    expect(tagFieldSections([only])).toEqual([])
  })

  it('renders a throwaway registry entry with no component change', () => {
    const mood: TagFieldDef = {
      key: 'mood',
      label: 'Mood',
      group: 'content',
      taglib: 'mood',
      kind: 'text',
      maxLength: 100,
      readOnly: false,
      admitted: true
    }
    const sections = tagFieldSections([mood])
    expect(sections).toEqual([{ group: 'content', label: 'Content', fields: [mood] }])
    const values = formValues(sections, { mood: cell('calm') })
    expect(values).toEqual({ mood: 'calm' })
    expect(buildTagFieldSave(sections, { mood: 'bright' }, values, {})).toEqual({
      patch: { mood: 'bright' },
      revert: [],
      errors: []
    })
  })
})

describe('formValue', () => {
  it('shapes a cell per kind', () => {
    expect(formValue(def('conductor'), cell('Karajan'))).toBe('Karajan')
    expect(formValue(def('bpm'), cell(128))).toBe('128')
    expect(formValue(def('composers'), cell(['Bach', 'Handel']))).toEqual(['Bach', 'Handel'])
    expect(formValue(def('compilation'), cell(true))).toBe(true)
    // Canonical empty: an unset flag is `null` in the fold, unchecked in the form.
    expect(formValue(def('compilation'), cell(null))).toBe(false)
    expect(formValue(def('replayGainTrackGain'), cell(-6.54321))).toBe('-6.5432')
  })

  it('starts a mixed cell empty, and a mixed flag indeterminate', () => {
    expect(formValue(def('conductor'), cell(null, { mixed: true }))).toBe('')
    expect(formValue(def('composers'), cell(null, { mixed: true }))).toEqual([])
    expect(formValue(def('compilation'), cell(null, { mixed: true }))).toBeNull()
  })

  it('treats a field missing from the fold as empty', () => {
    expect(formValue(def('conductor'), undefined)).toBe('')
  })
})

describe('tagFieldEdit', () => {
  it('leaves an untouched field out', () => {
    expect(tagFieldEdit(def('conductor'), 'A', 'A')).toEqual({ kind: 'unchanged' })
    expect(tagFieldEdit(def('composers'), ['A', 'B'], ['A', 'B'])).toEqual({ kind: 'unchanged' })
    expect(tagFieldEdit(def('compilation'), null, null)).toEqual({ kind: 'unchanged' })
  })

  it('turns an emptied field into the clear intent', () => {
    expect(tagFieldEdit(def('conductor'), '', 'A')).toEqual({ kind: 'set', value: null })
    expect(tagFieldEdit(def('bpm'), '  ', '120')).toEqual({ kind: 'set', value: null })
    expect(tagFieldEdit(def('composers'), [], ['A'])).toEqual({ kind: 'set', value: null })
  })

  it('treats list order as part of the value', () => {
    expect(tagFieldEdit(def('composers'), ['B', 'A'], ['A', 'B'])).toEqual({
      kind: 'set',
      value: ['B', 'A']
    })
  })

  it('parses ints and reports ones out of range', () => {
    expect(tagFieldEdit(def('bpm'), ' 96 ', '')).toEqual({ kind: 'set', value: 96 })
    expect(tagFieldEdit(def('bpm'), '0', '').kind).toBe('invalid')
    expect(tagFieldEdit(def('bpm'), '1000', '').kind).toBe('invalid')
    expect(tagFieldEdit(def('bpm'), '9.5', '').kind).toBe('invalid')
    expect(tagFieldEdit(def('bpm'), 'fast', '').kind).toBe('invalid')
  })

  it('sets a flag either way from a mixed batch', () => {
    expect(tagFieldEdit(def('compilation'), false, null)).toEqual({ kind: 'set', value: false })
    expect(tagFieldEdit(def('compilation'), true, false)).toEqual({ kind: 'set', value: true })
  })

  it('never edits a read-only field', () => {
    expect(tagFieldEdit(def('replayGainTrackGain'), '1', '-6')).toEqual({ kind: 'unchanged' })
  })
})

describe('buildTagFieldSave / tagFormDirty', () => {
  const sections = tagFieldSections()
  const initial = formValues(sections, {
    composers: cell(['Bach']),
    conductor: cell(null, { mixed: true }),
    bpm: cell(120, { overridden: true })
  })

  it('is clean when nothing moved', () => {
    expect(tagFormDirty(sections, { ...initial }, initial, {})).toBe(false)
    expect(buildTagFieldSave(sections, { ...initial }, initial, {})).toEqual({
      patch: {},
      revert: [],
      errors: []
    })
  })

  it('patches only the edited fields and routes reverts separately', () => {
    const values = { ...initial, composers: ['Bach', 'Handel'], bpm: '140' }
    const save = buildTagFieldSave(sections, values, initial, { bpm: true })
    expect(save).toEqual({ patch: { composers: ['Bach', 'Handel'] }, revert: ['bpm'], errors: [] })
    expect(tagFormDirty(sections, initial, initial, { bpm: true })).toBe(true)
  })

  it('collects errors instead of patching a bad number', () => {
    const save = buildTagFieldSave(sections, { ...initial, bpm: 'x' }, initial, {})
    expect(save.patch).toEqual({})
    expect(save.errors).toHaveLength(1)
  })
})

describe('isMultiline / formatTagValue', () => {
  it('gives the long free-text frames a multi-line input', () => {
    expect(isMultiline(def('lyrics'))).toBe(true)
    expect(isMultiline(def('conductor'))).toBe(false)
    expect(isMultiline(def('composers'))).toBe(false)
  })

  it('formats values per kind', () => {
    expect(formatTagValue(def('composers'), ['A', 'B'])).toBe('A; B')
    expect(formatTagValue(def('composers'), [])).toBe('—')
    expect(formatTagValue(def('compilation'), false)).toBe('No')
    expect(formatTagValue(def('bpm'), 120)).toBe('120')
    expect(formatTagValue(def('replayGainAlbumPeak'), 0.98828125)).toBe('0.9883')
    expect(formatTagValue(def('conductor'), null)).toBe('—')
  })
})

describe('buildTagInfoSections', () => {
  it('keeps only fields with a value, in editor group order', () => {
    const sections = buildTagInfoSections({
      conductor: cell('Karajan'),
      composers: cell(['Bach', 'Handel']),
      bpm: cell(120),
      publisher: cell(''),
      artistSort: cell([]),
      isrc: cell(null)
    })
    expect(sections.map((section) => section.group)).toEqual(['credits', 'content'])
    expect(sections[0]?.rows.map((row) => [row.key, row.value])).toEqual([
      ['composers', 'Bach; Handel'],
      ['conductor', 'Karajan']
    ])
    expect(sections[1]?.rows.map((row) => [row.key, row.value])).toEqual([['bpm', '120']])
  })

  it('shows a raised flag and drops a lowered one', () => {
    expect(buildTagInfoSections({ compilation: cell(false) })).toEqual([])
    expect(buildTagInfoSections({ compilation: cell(true) })[0]?.rows[0]?.value).toBe('Yes')
  })

  it('leaves out the read-only group, mixed cells and held fields', () => {
    expect(
      buildTagInfoSections({
        replayGainTrackGain: cell(-6.5),
        subtitle: cell('Live', { mixed: true }),
        comment: cell('held')
      })
    ).toEqual([])
  })

  it('marks free-text frames as multiline', () => {
    const [section] = buildTagInfoSections({ lyrics: cell('la la'), initialKey: cell('Am') })
    expect(section?.rows.map((row) => [row.key, row.multiline])).toEqual([
      ['lyrics', true],
      ['initialKey', false]
    ])
  })

  it('draws a throwaway registry entry with no component change', () => {
    const extra: TagFieldDef = {
      key: 'mood',
      label: 'Mood',
      group: 'content',
      taglib: 'mood',
      kind: 'text',
      maxLength: 100,
      readOnly: false,
      admitted: true
    }
    const sections = buildTagInfoSections({ mood: cell('Wistful') }, [...TAG_FIELDS, extra])
    expect(sections[0]?.rows).toEqual([
      { key: 'mood', label: 'Mood', value: 'Wistful', multiline: false }
    ])
  })
})
