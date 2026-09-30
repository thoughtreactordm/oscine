import { describe, expect, it } from 'vitest'
import { Tag, XiphComment } from 'node-taglib-sharp'
import {
  TAG_FIELD_GROUP_LABELS,
  TAG_FIELD_GROUPS,
  TAG_FIELDS,
  isEditableTagField,
  isTagFieldKey,
  tagField,
  tagValuesEqual
} from '@shared/tagFields'
import { OVERRIDE_FIELDS } from '@shared/overrides'

/**
 * The generic tag-field registry — **W16-15**. Its integrity is the contract
 * every consumer leans on: keys are persisted, and each `taglib` name is the
 * accessor the writer and verify will call on node-taglib-sharp's `Tag`.
 */

function accessor(name: string): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(Tag.prototype, name)
}

describe('tag field registry', () => {
  it('has unique keys', () => {
    const keys = TAG_FIELDS.map((field) => field.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('maps every field to an accessor on the portable Tag', () => {
    for (const field of TAG_FIELDS) {
      expect(accessor(field.taglib)?.get, `${field.key} → Tag.${field.taglib}`).toBeTypeOf(
        'function'
      )
      expect(accessor(field.taglib)?.set, `${field.key} → Tag.${field.taglib}`).toBeTypeOf(
        'function'
      )
    }
  })

  it('maps no two fields to the same taglib property', () => {
    const properties = TAG_FIELDS.map((field) => field.taglib)
    expect(new Set(properties).size).toBe(properties.length)
  })

  it('never describes a grouped field (Decision E)', () => {
    const grouped = new Set<string>(OVERRIDE_FIELDS)
    for (const field of TAG_FIELDS) expect(grouped.has(field.key)).toBe(false)
    for (const property of ['title', 'performers', 'albumArtists', 'album', 'track', 'disc']) {
      expect(TAG_FIELDS.some((field) => field.taglib === property)).toBe(false)
    }
    for (const property of ['year', 'genres']) {
      expect(TAG_FIELDS.some((field) => field.taglib === property)).toBe(false)
    }
  })

  it('excludes the Decision F fields outright', () => {
    const excluded = [
      'amazonId',
      'musicIpId',
      'dateTagged',
      'performersRole',
      'pictures',
      'firstAlbumArtist',
      'firstAlbumArtistSort',
      'firstPerformer',
      'firstPerformerSort',
      'firstComposer',
      'firstComposerSort',
      'firstGenre',
      'joinedAlbumArtists',
      'joinedPerformers',
      'joinedPerformersSort',
      'joinedComposers',
      'joinedGenres'
    ]
    for (const property of excluded) {
      expect(TAG_FIELDS.some((field) => field.taglib === property)).toBe(false)
    }
  })

  it('marks exactly the four ReplayGain values read-only, and only they are real', () => {
    const readOnly = TAG_FIELDS.filter((field) => field.readOnly).map((field) => field.taglib)
    expect(readOnly.sort()).toEqual([
      'replayGainAlbumGain',
      'replayGainAlbumPeak',
      'replayGainTrackGain',
      'replayGainTrackPeak'
    ])
    for (const field of TAG_FIELDS) {
      expect(field.kind === 'real', field.key).toBe(field.readOnly)
      expect(field.group === 'readOnly', field.key).toBe(field.readOnly)
    }
  })

  it('keeps the MusicBrainz ids editable in the Advanced group', () => {
    for (const field of TAG_FIELDS.filter((f) => f.taglib.startsWith('musicBrainz'))) {
      expect(field.group).toBe('advanced')
      expect(field.readOnly).toBe(false)
    }
  })

  it('types each field by the shape its taglib accessor holds', () => {
    // An empty tag's getters return their empty value, whose shape is the kind's.
    const probe = XiphComment.fromEmpty()
    for (const field of TAG_FIELDS) {
      const empty = (probe as unknown as Record<string, unknown>)[field.taglib]
      const expected = {
        text: 'string',
        list: 'array',
        int: 'number',
        real: 'number',
        bool: 'boolean'
      }[field.kind]
      const actual = Array.isArray(empty) ? 'array' : typeof empty
      // An absent text frame reads as undefined, not ''; there is no shape to check.
      if (empty !== undefined) expect(actual, field.key).toBe(expected)
    }
  })

  it('bounds every int field to a positive range', () => {
    for (const field of TAG_FIELDS) {
      if (field.kind !== 'int') continue
      expect(field.min).toBeGreaterThanOrEqual(1)
      expect(field.max).toBeGreaterThan(field.min)
    }
  })

  it('puts every field in a labelled group', () => {
    for (const field of TAG_FIELDS) expect(TAG_FIELD_GROUPS).toContain(field.group)
    for (const group of TAG_FIELD_GROUPS) expect(TAG_FIELD_GROUP_LABELS[group]).toBeTruthy()
  })

  it('offers nothing until the corpus admits it (Decision D)', () => {
    for (const field of TAG_FIELDS) {
      if (!field.admitted) expect(isEditableTagField(field)).toBe(false)
      if (field.readOnly) expect(isEditableTagField(field)).toBe(false)
    }
  })

  it('looks fields up by key and refuses unknown keys', () => {
    expect(tagField('composers')?.kind).toBe('list')
    expect(tagField('amazonId')).toBeUndefined()
    expect(isTagFieldKey('bpm')).toBe(true)
    expect(isTagFieldKey('title')).toBe(false)
  })
})

describe('tagValuesEqual', () => {
  it('compares lists by value, in order', () => {
    expect(tagValuesEqual(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(tagValuesEqual(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(tagValuesEqual(['a'], ['a', 'b'])).toBe(false)
  })

  it('compares scalars by identity and distinguishes empty from absent', () => {
    expect(tagValuesEqual('x', 'x')).toBe(true)
    expect(tagValuesEqual(120, 120)).toBe(true)
    expect(tagValuesEqual(true, false)).toBe(false)
    expect(tagValuesEqual(null, null)).toBe(true)
    expect(tagValuesEqual(null, '')).toBe(false)
    expect(tagValuesEqual(['a'], 'a')).toBe(false)
  })
})
