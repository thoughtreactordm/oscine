import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tag } from 'node-taglib-sharp'
import { tagField, type TagFieldKey, type TagFieldValue } from '@shared/tagFields'
import type { FieldDiff, PendingWrite } from '@shared/tagWriteback'
import { ABSENT_ARTWORK } from '@shared/artwork'
import type { TrackTags } from '../../../../src/main/library/metadata'
import {
  computePendingWrite,
  flushableOverrideKeys,
  NO_OVERRIDE
} from '../../../../src/main/library/writeback/diff'
import { writeTags } from '../../../../src/main/library/writeback/engine'
import {
  applyTagFields,
  canonicalTagValue,
  readTagFieldsFromTag,
  refusedTagField,
  verifyTagFields,
  type TagFieldReader
} from '../../../../src/main/library/writeback/genericFields'
import { TagWritebackService } from '../../../../src/main/library/writeback/service'
import {
  applyWritableTags,
  ARTWORK_UNCHANGED,
  selectionChangesFile,
  writableTagsFromSelection,
  type WritableTags
} from '../../../../src/main/library/writeback/writer'
import { pinAdmission } from '../../../support/pinAdmission'

/**
 * The generic tier's read → diff → write → verify — **W16-17**, Decision E.
 *
 * Everything here runs on injected seams: a recording stand-in for taglib's
 * `Tag`, a synthesised file read, and the engine's `applyTags`/`read`/
 * `readFields`. The real-codec round-trip is `genericFlush.test.ts`.
 */

// The held key the refusal tests name, whatever the corpus gate has admitted.
pinAdmission({ musicBrainzArtistId: false })

function fileTags(over: Partial<TrackTags> = {}): TrackTags {
  return {
    title: 'Title',
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: 4,
    discNo: 1,
    year: 2026,
    durationMs: null,
    codec: 'flac',
    sampleRate: null,
    channels: null,
    bitDepth: null,
    genre: 'Ambient',
    replayGain: null,
    lyrics: null,
    ...over
  }
}

/**
 * A `Tag` stand-in that records every property assigned, so a test can prove
 * which frames a write touched. Unset properties read as taglib's own empties.
 */
function recordingTag(initial: Record<string, unknown> = {}): {
  tag: Tag
  store: Record<string, unknown>
  assigned: Set<string>
} {
  const store: Record<string, unknown> = { ...initial }
  const assigned = new Set<string>()
  const tag = new Proxy(store, {
    set(target, property, value) {
      assigned.add(String(property))
      target[String(property)] = value
      return true
    }
  }) as unknown as Tag
  return { tag, store, assigned }
}

const BASE: WritableTags = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  trackNo: 4,
  discNo: 1,
  year: 2026,
  genres: [{ key: 'ambient', label: 'Ambient' }],
  artwork: ARTWORK_UNCHANGED
}

describe('canonicalTagValue — one empty per kind', () => {
  it('folds each kind’s taglib empty to null', () => {
    expect(canonicalTagValue(tagField('conductor')!, undefined)).toBeNull()
    expect(canonicalTagValue(tagField('conductor')!, '')).toBeNull()
    expect(canonicalTagValue(tagField('bpm')!, 0)).toBeNull()
    expect(canonicalTagValue(tagField('compilation')!, false)).toBeNull()
    expect(canonicalTagValue(tagField('composers')!, [])).toBeNull()
    expect(canonicalTagValue(tagField('replayGainTrackGain')!, Number.NaN)).toBeNull()
  })

  it('keeps a real value exactly, text untrimmed and lists in order', () => {
    expect(canonicalTagValue(tagField('lyrics')!, ' verse\n')).toBe(' verse\n')
    expect(canonicalTagValue(tagField('bpm')!, 128)).toBe(128)
    expect(canonicalTagValue(tagField('compilation')!, true)).toBe(true)
    expect(canonicalTagValue(tagField('composers')!, ['B', 'A'])).toEqual(['B', 'A'])
    expect(canonicalTagValue(tagField('replayGainTrackGain')!, -7.25)).toBe(-7.25)
  })

  it('reads a value that does not fit the kind as absent rather than throwing', () => {
    expect(canonicalTagValue(tagField('bpm')!, '128')).toBeNull()
    expect(canonicalTagValue(tagField('compilation')!, 1)).toBeNull()
  })
})

describe('applyTagFields — exactly the keys present', () => {
  it('sets each field through its registry taglib property', () => {
    const { tag, store } = recordingTag()
    applyTagFields(tag, {
      conductor: 'Nadia Boulanger',
      trackTotal: 14,
      compilation: true,
      composers: ['Hildegard von Bingen', 'Arvo Pärt']
    })
    expect(store.conductor).toBe('Nadia Boulanger')
    expect(store.trackCount).toBe(14)
    expect(store.isCompilation).toBe(true)
    // A list is a native multi-value frame (Decision G), not a joined string.
    expect(store.composers).toEqual(['Hildegard von Bingen', 'Arvo Pärt'])
  })

  it('clears with the corpus-proven shape per kind', () => {
    const { tag, store, assigned } = recordingTag({
      conductor: 'x',
      bpm: 120,
      isCompilation: true,
      composers: ['x']
    })
    applyTagFields(tag, { conductor: null, bpm: null, compilation: null, composers: null })
    expect(assigned).toEqual(new Set(['conductor', 'beatsPerMinute', 'isCompilation', 'composers']))
    expect(store.conductor).toBeUndefined()
    expect(store.beatsPerMinute).toBe(0)
    expect(store.isCompilation).toBe(false)
    expect(store.composers).toEqual([])
  })

  it('refuses a held, read-only or unknown key before assigning anything', () => {
    for (const key of ['musicBrainzArtistId', 'replayGainTrackGain', 'notAField']) {
      const { tag, assigned } = recordingTag()
      expect(() => applyTagFields(tag, { conductor: 'x', [key]: 'y' })).toThrow(/refusing/)
      expect(assigned.size).toBe(0)
    }
  })

  it('names the first unflushable key', () => {
    expect(refusedTagField(['conductor', 'bpm'])).toBeNull()
    expect(refusedTagField(['conductor', 'musicBrainzArtistId'])).toBe('musicBrainzArtistId')
  })
})

describe('applyWritableTags — generic fields ride alongside the grouped ones', () => {
  it('never assigns a generic property the write does not name', () => {
    const { tag, assigned } = recordingTag()
    applyWritableTags({ tag } as never, { ...BASE, fields: { bpm: 128 } })
    const genericAssigned = [...assigned].filter((property) =>
      ['beatsPerMinute', 'conductor', 'composers', 'isCompilation', 'comment', 'lyrics'].includes(
        property
      )
    )
    expect(genericAssigned).toEqual(['beatsPerMinute'])
  })

  it('assigns no generic property at all when the write carries none', () => {
    const { tag, assigned } = recordingTag()
    applyWritableTags({ tag } as never, BASE)
    expect(assigned.has('beatsPerMinute')).toBe(false)
    expect(assigned.has('composers')).toBe(false)
  })
})

describe('verifyTagFields', () => {
  it('passes a matching read, a clear against an absent read, and a list by order', () => {
    const after = new Map<TagFieldKey, TagFieldValue | null>([
      ['composers', ['A', 'B']],
      ['conductor', null],
      ['compilation', null]
    ])
    expect(
      verifyTagFields(after, { composers: ['A', 'B'], conductor: null, compilation: false })
    ).toBeNull()
  })

  it('names the first field the file does not hold', () => {
    const after = new Map<TagFieldKey, TagFieldValue | null>([['composers', ['B', 'A']]])
    expect(verifyTagFields(after, { composers: ['A', 'B'] })).toMatch(/^composers: expected/)
  })
})

describe('writeTags — generic fields (injected seams)', () => {
  let dir: string
  let path: string
  const ORIGINAL = 'original-bytes'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-wb-generic-'))
    path = join(dir, 'track.flac')
    writeFileSync(path, ORIGINAL)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A fake container: `applyTags` runs the real field mapping onto a recording
   * tag and stamps the temp copy; `readFields` reads the same tag back the way
   * the taglib reader does. `lie` overrides what the read-back reports.
   */
  function fakeContainer(
    initial: Record<string, unknown> = {},
    lie: Partial<Record<TagFieldKey, TagFieldValue | null>> = {}
  ) {
    const recording = recordingTag(initial)
    const applyTags = (tempPath: string, desired: WritableTags): void => {
      applyWritableTags({ tag: recording.tag } as never, desired)
      writeFileSync(tempPath, 'written-bytes')
    }
    const readFields: TagFieldReader = async (_path, keys) => {
      const values = readTagFieldsFromTag(recording.store as unknown as Tag, keys)
      for (const [key, value] of Object.entries(lie)) {
        values.set(key as TagFieldKey, value ?? null)
      }
      return values
    }
    return { recording, applyTags, readFields, read: async () => fileTags() }
  }

  const cases: Array<[string, WritableTags['fields'], Record<string, unknown>]> = [
    ['set (text)', { conductor: 'Nadia Boulanger' }, { conductor: 'Nadia Boulanger' }],
    ['clear (text)', { conductor: null }, { conductor: undefined }],
    ['list', { composers: ['A', 'B'] }, { composers: ['A', 'B'] }],
    ['bool', { compilation: true }, { isCompilation: true }],
    ['int', { discTotal: 3 }, { discCount: 3 }]
  ]

  for (const [name, fields, expected] of cases) {
    it(`writes and verifies a ${name} field`, async () => {
      const container = fakeContainer({ conductor: 'Old' })
      const outcome = await writeTags(path, { ...BASE, fields }, container)
      expect(outcome.ok).toBe(true)
      for (const [property, value] of Object.entries(expected)) {
        expect(container.recording.store[property]).toEqual(value)
      }
      expect(readFileSync(path, 'utf8')).toBe('written-bytes')
    })
  }

  it('never assigns a generic property the write does not name', async () => {
    const container = fakeContainer()
    await writeTags(path, { ...BASE, fields: { bpm: 128 } }, container)
    const touched = [...container.recording.assigned].filter(
      (property) =>
        !['title', 'performers', 'album', 'genres', 'year', 'track', 'disc'].includes(property)
    )
    expect(touched).toEqual(['beatsPerMinute'])
  })

  it('does not consult the field reader when the write carries no generic field', async () => {
    let read = 0
    const container = fakeContainer()
    const outcome = await writeTags(path, BASE, {
      ...container,
      readFields: async (...args) => {
        read += 1
        return container.readFields(...args)
      }
    })
    expect(outcome.ok).toBe(true)
    expect(read).toBe(0)
  })

  it('fails verify on a mismatched field and rolls the original back byte-identical', async () => {
    const container = fakeContainer({}, { composers: ['B', 'A'] })
    const outcome = await writeTags(path, { ...BASE, fields: { composers: ['A', 'B'] } }, container)
    expect(outcome).toMatchObject({ ok: false, code: 'verify-failed' })
    if (!outcome.ok) expect(outcome.reason).toMatch(/^composers: expected/)
    expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)
    expect(readdirSync(dir).filter((name) => name.includes('oscine-wb-'))).toEqual([])
  })

  it('refuses a held field before the file is touched', async () => {
    let applied = false
    const outcome = await writeTags(
      path,
      { ...BASE, fields: { conductor: 'x', musicBrainzArtistId: 'held' } },
      {
        applyTags: () => {
          applied = true
        },
        read: async () => fileTags()
      }
    )
    expect(outcome).toMatchObject({ ok: false, code: 'write-failed' })
    if (!outcome.ok) expect(outcome.reason).toMatch(/musicBrainzArtistId/)
    expect(applied).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)
    expect(readdirSync(dir)).toEqual(['track.flac'])
  })
})

describe('computePendingWrite — generic diffs', () => {
  function pendingFor(
    overrides: Array<[TagFieldKey, TagFieldValue | null]>,
    file: Array<[TagFieldKey, TagFieldValue | null]>
  ): PendingWrite {
    return computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: NO_OVERRIDE,
      userTags: [],
      tagOverrides: new Map(overrides),
      fileFields: new Map(file)
    })
  }

  it('diffs only the corrected fields, against the fresh read', () => {
    const pending = pendingFor(
      [
        ['conductor', 'New'],
        ['composers', ['A', 'B']]
      ],
      [
        ['conductor', 'Old'],
        ['composers', ['A', 'B']],
        ['bpm', 120]
      ]
    )
    expect(pending.fields).toEqual({
      conductor: { current: 'Old', proposed: 'New', changed: true },
      composers: { current: ['A', 'B'], proposed: ['A', 'B'], changed: false }
    })
    expect(pending.hasChanges).toBe(true)
  })

  it('compares a list by ordered value', () => {
    const pending = pendingFor([['composers', ['B', 'A']]], [['composers', ['A', 'B']]])
    expect(pending.fields.composers?.changed).toBe(true)
  })

  it('treats a false flag and an absent one as the same, and a clear of an absent field as no change', () => {
    const pending = pendingFor(
      [
        ['compilation', false],
        ['conductor', null]
      ],
      []
    )
    expect(pending.fields.compilation).toEqual({ current: null, proposed: null, changed: false })
    expect(pending.fields.conductor?.changed).toBe(false)
    expect(pending.hasChanges).toBe(false)
  })

  it('leaves a held or read-only correction out of the diff', () => {
    const pending = pendingFor(
      [
        ['musicBrainzArtistId', 'held'],
        ['replayGainTrackGain', -3]
      ],
      []
    )
    expect(pending.fields).toEqual({})
    expect(flushableOverrideKeys(new Map([['musicBrainzArtistId', 'x']]))).toEqual([])
  })
})

/** A minimal pending write carrying only generic diffs. */
function genericPending(
  trackId: number,
  fields: Partial<Record<TagFieldKey, FieldDiff<TagFieldValue>>>
): PendingWrite {
  const same = <T>(value: T): FieldDiff<T> => ({ current: value, proposed: value, changed: false })
  return {
    trackId,
    title: same('Title'),
    artist: same('Artist'),
    albumArtist: same<string>('Band'),
    album: same('Album'),
    trackNo: same(1),
    discNo: same(1),
    year: same(2020),
    genres: { current: [], proposed: [], changed: false },
    artwork: { current: ABSENT_ARTWORK, proposed: ABSENT_ARTWORK, changed: false },
    fields,
    hasChanges: Object.values(fields).some((diff) => diff?.changed === true)
  }
}

describe('selection → generic write', () => {
  const pending = genericPending(1, {
    conductor: { current: 'Old', proposed: 'New', changed: true },
    bpm: { current: 120, proposed: 120, changed: false },
    composers: { current: ['A'], proposed: null, changed: true }
  })

  it('writes only selected, changed generic fields', () => {
    expect(writableTagsFromSelection(pending, new Set(['conductor', 'bpm'])).fields).toEqual({
      conductor: 'New'
    })
    expect(writableTagsFromSelection(pending, new Set(['composers'])).fields).toEqual({
      composers: null
    })
    expect(writableTagsFromSelection(pending, new Set(['title'])).fields).toEqual({})
  })

  it('counts a selected generic change as changing the file', () => {
    expect(selectionChangesFile(pending, new Set(['conductor']))).toBe(true)
    expect(selectionChangesFile(pending, new Set(['bpm']))).toBe(false)
  })
})

describe('TagWritebackService — generic flush', () => {
  const pending = genericPending(1, {
    conductor: { current: 'Old', proposed: 'New', changed: true }
  })

  function service(writes: WritableTags[], retired: Array<readonly string[]>) {
    return new TagWritebackService({
      differ: { pendingWrite: async () => pending },
      resolvePath: () => '/music/a.flac',
      write: async (absPath, desired) => {
        writes.push(desired)
        return { ok: true, codec: 'flac', path: absPath }
      },
      retire: (_trackId, fields) => {
        retired.push(fields)
      }
    })
  }

  it('flushes a selected generic field and retires it after the write', async () => {
    const writes: WritableTags[] = []
    const retired: Array<readonly string[]> = []
    const report = await service(writes, retired).apply(
      [{ trackId: 1, fields: ['conductor'] }],
      () => {}
    )
    expect(report.written).toBe(1)
    expect(writes[0].fields).toEqual({ conductor: 'New' })
    expect(retired).toEqual([['conductor']])
  })

  it('refuses a selection naming a held field, and retires nothing', async () => {
    const writes: WritableTags[] = []
    const retired: Array<readonly string[]> = []
    const report = await service(writes, retired).apply(
      [{ trackId: 1, fields: ['conductor', 'musicBrainzArtistId'] }],
      () => {}
    )
    expect(report.outcomes).toEqual([{ trackId: 1, status: 'failed', code: 'write-failed' }])
    expect(writes).toEqual([])
    expect(retired).toEqual([])
  })
})
