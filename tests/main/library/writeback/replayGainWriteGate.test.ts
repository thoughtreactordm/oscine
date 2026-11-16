import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tag } from 'node-taglib-sharp'
import { OscineError } from '@shared/errors'
import {
  isEditableTagField,
  isFlushableTagField,
  isShownTagField,
  prefillTagFieldKeys,
  TAG_FIELDS,
  tagField,
  type TagFieldDef,
  type TagFieldKey,
  type TagFieldValue
} from '@shared/tagFields'
import { openDatabase } from '../../../../src/main/db'
import { assertSetTagOverridesRequest } from '../../../../src/main/ipc/validate'
import type { MetadataReader, TrackTags } from '../../../../src/main/library/metadata'
import { SqliteLibraryService } from '../../../../src/main/library/sqliteService'
import { flushableOverrideKeys } from '../../../../src/main/library/writeback/diff'
import { TagWritebackDiffer } from '../../../../src/main/library/writeback/differ'
import { writeTags } from '../../../../src/main/library/writeback/engine'
import {
  readTagFieldsFromTag,
  refusedTagField,
  type TagFieldReader
} from '../../../../src/main/library/writeback/genericFields'
import {
  applyWritableTags,
  ARTWORK_UNCHANGED,
  type WritableTags
} from '../../../../src/main/library/writeback/writer'
import { pinAdmission } from '../../../support/pinAdmission'

/**
 * The ReplayGain write gate — **W25-3 (RG-3)**, `oscine-replaygain` D37
 * Decision B, which amends `oscine-tag-writeback` Decision F.
 *
 * `readOnly` stops meaning "never written" and starts meaning "never
 * hand-edited". The flush admits a ReplayGain key on admission alone, so a row
 * the staging service puts in `track_tag_overrides` can reach the file; every
 * hand-edit entry point still refuses the same key. Until W16-16's corpus rows
 * for the four fields are green they are `held()`, so the flush refuses them too.
 *
 * "From staging" is simulated here by inserting the row directly — that is what
 * the RG-4 staging service will do, and it never goes through `setTagOverrides`.
 */

const RG_KEYS = [
  'replayGainTrackGain',
  'replayGainTrackPeak',
  'replayGainAlbumGain',
  'replayGainAlbumPeak'
] as const

function fileTags(over: Partial<TrackTags> = {}): TrackTags {
  return {
    title: 'Title',
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: 1,
    discNo: 1,
    year: 2026,
    durationMs: 200_000,
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    genre: null,
    replayGain: null,
    lyrics: null,
    ...over
  }
}

const BASE: WritableTags = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genres: [],
  artwork: ARTWORK_UNCHANGED
}

describe('the registry — read-only, held, still shown', () => {
  it('keeps the four ReplayGain fields read-only and held', () => {
    for (const key of RG_KEYS) {
      const field = tagField(key) as TagFieldDef
      expect(field.readOnly, key).toBe(true)
      expect(field.admitted, key).toBe(false)
      expect(isEditableTagField(field), key).toBe(false)
      expect(isFlushableTagField(field), key).toBe(false)
    }
  })

  it('still shows and prefills them while held (Decision F: shown)', () => {
    const prefill = prefillTagFieldKeys()
    for (const key of RG_KEYS) {
      expect(isShownTagField(tagField(key) as TagFieldDef), key).toBe(true)
      expect(prefill, key).toContain(key)
    }
  })

  it('gates the flush on admission alone, and hand-edits on admission and read-only', () => {
    for (const field of TAG_FIELDS) {
      expect(isFlushableTagField(field), field.key).toBe(field.admitted)
      expect(isEditableTagField(field), field.key).toBe(field.admitted && !field.readOnly)
    }
    const admittedGain = { ...(tagField('replayGainTrackGain') as TagFieldDef), admitted: true }
    expect(isFlushableTagField(admittedGain)).toBe(true)
    expect(isEditableTagField(admittedGain)).toBe(false)
  })
})

describe('the flush — held refuses, admitted writes a staged gain', () => {
  describe('while held', () => {
    it('refuses every ReplayGain key at the write gate', () => {
      for (const key of RG_KEYS) expect(refusedTagField([key])).toBe(key)
      const staged = new Map<TagFieldKey, TagFieldValue | null>([['replayGainTrackGain', -6.5]])
      expect(flushableOverrideKeys(staged)).toEqual([])
    })
  })

  describe('once admitted', () => {
    pinAdmission(Object.fromEntries(RG_KEYS.map((key) => [key, true])))

    let dir: string
    let path: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'oscine-rg-gate-'))
      path = join(dir, 'track.flac')
      writeFileSync(path, 'original-bytes')
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('admits a read-only key at the write gate and in the diff', () => {
      for (const key of RG_KEYS) expect(refusedTagField([key])).toBeNull()
      const staged = new Map<TagFieldKey, TagFieldValue | null>([
        ['replayGainTrackGain', -6.5],
        ['replayGainTrackPeak', 0.98]
      ])
      expect(flushableOverrideKeys(staged)).toEqual(['replayGainTrackGain', 'replayGainTrackPeak'])
    })

    it('writes and verifies a staged gain through the engine', async () => {
      const store: Record<string, unknown> = {}
      const tag = store as unknown as Tag
      const readFields: TagFieldReader = async (_path, keys) => readTagFieldsFromTag(tag, keys)
      const outcome = await writeTags(
        path,
        { ...BASE, fields: { replayGainTrackGain: -6.5, replayGainTrackPeak: 0.98 } },
        {
          applyTags: (tempPath, desired) => {
            applyWritableTags({ tag } as never, desired)
            writeFileSync(tempPath, 'written-bytes')
          },
          read: async () => fileTags(),
          readFields
        }
      )
      expect(outcome).toMatchObject({ ok: true })
      expect(store.replayGainTrackGain).toBe(-6.5)
      expect(store.replayGainTrackPeak).toBe(0.98)
      expect(readFileSync(path, 'utf8')).toBe('written-bytes')
    })

    it('still refuses the same key from tagOverrides.set validation', () => {
      for (const key of RG_KEYS) {
        expect(() => assertSetTagOverridesRequest({ trackIds: [1], patch: { [key]: -6 } })).toThrow(
          OscineError
        )
      }
    })
  })
})

describe('the hand-edit sink — LibraryService.setTagOverrides', () => {
  // Admitted, so the refusal below is read-only's alone, not the hold's.
  pinAdmission(Object.fromEntries(RG_KEYS.map((key) => [key, true])))

  let workDir: string
  let db: ReturnType<typeof openDatabase>['db']
  let service: SqliteLibraryService
  let trackId: number

  const readMetadata: MetadataReader = async () => fileTags()
  const readFields: TagFieldReader = async (_path, keys) =>
    new Map(keys.map((key) => [key, key === 'replayGainTrackGain' ? -3 : null]))

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'oscine-rg-sink-'))
    const music = join(workDir, 'Music')
    mkdirSync(music)
    writeFileSync(join(music, 'a.flac'), 'x')
    db = openDatabase(join(workDir, 'library.db')).db
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => music,
      onProgress: () => {},
      readMetadata,
      readTagFields: readFields
    })
    const root = await service.addRoot()
    await service.scanRoot(root!.id)
    trackId = (db.prepare('SELECT id FROM tracks').get() as { id: number }).id
  })

  afterEach(async () => {
    await service.close()
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  const rgRows = (): number =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM track_tag_overrides WHERE field LIKE 'replayGain%'")
        .get() as { n: number }
    ).n

  it('refuses a hand-typed gain even when a caller skips validation', async () => {
    await expect(
      service.setTagOverrides({ trackIds: [trackId], patch: { replayGainTrackGain: -6 } })
    ).rejects.toThrow(OscineError)
    // Nothing of a mixed patch lands either: the refusal comes before the write.
    await expect(
      service.setTagOverrides({
        trackIds: [trackId],
        patch: { conductor: 'x', replayGainAlbumGain: -6 }
      })
    ).rejects.toThrow(/not a hand-editable/)
    expect(rgRows()).toBe(0)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM track_tag_overrides').get() as { n: number }).n
    ).toBe(0)
  })

  it('diffs a row staged outside the hand-edit path', async () => {
    db.prepare(
      "INSERT INTO track_tag_overrides (track_id, field, value, updated_at) VALUES (?, 'replayGainTrackGain', '-6.5', 1)"
    ).run(trackId)
    const differ = new TagWritebackDiffer(db, readMetadata, readFields)
    expect((await differ.pendingWrite(trackId))?.fields).toEqual({
      replayGainTrackGain: { current: -3, proposed: -6.5, changed: true }
    })
  })
})
