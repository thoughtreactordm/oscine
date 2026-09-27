import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TagFieldKey, TagFieldValue } from '@shared/tagFields'
import { openDatabase } from '../../../../src/main/db'
import type { MetadataReader, TrackTags } from '../../../../src/main/library/metadata'
import { SqliteLibraryService } from '../../../../src/main/library/sqliteService'
import { TagWritebackDiffer } from '../../../../src/main/library/writeback/differ'
import {
  readTagFields,
  type TagFieldReader
} from '../../../../src/main/library/writeback/genericFields'
import {
  TagWritebackService,
  trackPathResolver
} from '../../../../src/main/library/writeback/service'
import { buildWritebackCorpus } from '../../../../scripts/lib/writeback-corpus.mjs'

/**
 * The generic tier through the database — **W16-17**.
 *
 * The first suite drives the service and differ over a real `library.db` with a
 * synthesised file read: the pending set and "modified" mark, the lazy generic
 * read, retirement, and the editor's prefill. The second is the card's
 * acceptance on real files: scan → correct → flush → wipe → rescan, on every v1
 * codec, skipped where ffmpeg is absent exactly as the corpus gate is.
 */

function tags(over: Partial<TrackTags> = {}): TrackTags {
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

describe('generic corrections through the library service (synthesised files)', () => {
  let workDir: string
  let db: ReturnType<typeof openDatabase>['db']
  let service: SqliteLibraryService
  let fileFields: Map<TagFieldKey, TagFieldValue | null>
  let fieldReads: number
  let trackId: number

  const readMetadata: MetadataReader = async () => tags()
  const readFields: TagFieldReader = async (_path, keys) => {
    fieldReads += 1
    return new Map(keys.map((key) => [key, fileFields.get(key) ?? null]))
  }

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'oscine-generic-svc-'))
    const music = join(workDir, 'Music')
    mkdirSync(music)
    writeFileSync(join(music, 'a.flac'), 'x')
    db = openDatabase(join(workDir, 'library.db')).db
    fileFields = new Map([['conductor', 'Old']])
    fieldReads = 0
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

  const modified = async (): Promise<boolean> =>
    (await service.getTracksByIds({ ids: [trackId] }))[0].modified

  it('lists and marks a track with a flushable generic correction', async () => {
    expect(await service.pendingWritebackTrackIds()).toEqual([])
    expect(await modified()).toBe(false)

    await service.setTagOverrides({ trackIds: [trackId], patch: { conductor: 'New' } })

    expect(await service.pendingWritebackTrackIds()).toEqual([trackId])
    expect(await modified()).toBe(true)
  })

  it('does not list or mark a track whose only correction is under a held key', async () => {
    db.prepare(
      "INSERT INTO track_tag_overrides (track_id, field, value, updated_at) VALUES (?, 'comment', '\"x\"', 1)"
    ).run(trackId)
    expect(await service.pendingWritebackTrackIds()).toEqual([])
    expect(await modified()).toBe(false)
  })

  it('reads generic fields only for a track carrying a generic correction', async () => {
    const differ = new TagWritebackDiffer(db, readMetadata, readFields)
    expect((await differ.pendingWrite(trackId))?.fields).toEqual({})
    expect(fieldReads).toBe(0)

    await service.setTagOverrides({ trackIds: [trackId], patch: { conductor: 'New' } })
    expect((await differ.pendingWrite(trackId))?.fields).toEqual({
      conductor: { current: 'Old', proposed: 'New', changed: true }
    })
    expect(fieldReads).toBe(1)
  })

  it('retires the generic rows a flush wrote, and only those', async () => {
    await service.setTagOverrides({
      trackIds: [trackId],
      patch: { conductor: 'New', bpm: 128 }
    })
    await service.retireWrittenOverrides(trackId, ['conductor'])
    const rows = db
      .prepare('SELECT field FROM track_tag_overrides WHERE track_id = ?')
      .all(trackId) as Array<{ field: string }>
    expect(rows.map((row) => row.field)).toEqual(['bpm'])
    expect(await service.pendingWritebackTrackIds()).toEqual([trackId])
  })

  it('prefills from the file, overlaid by corrections', async () => {
    fileFields.set('composers', ['A', 'B'])
    await service.setTagOverrides({ trackIds: [trackId], patch: { conductor: null } })

    const state = await service.getTagFieldEditState([trackId])

    expect(state.conductor).toEqual({ value: null, mixed: false, overridden: true })
    expect(state.composers).toEqual({ value: ['A', 'B'], mixed: false, overridden: false })
    // Read-only ReplayGain is prefilled; a held field is not.
    expect(state).toHaveProperty('replayGainTrackGain')
    expect(state).not.toHaveProperty('comment')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const onCorpus = hasFfmpeg ? describe : describe.skip

onCorpus('generic flush on the corpus — scan → correct → flush → wipe → rescan', () => {
  let root: string
  let libraryDir: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'oscine-generic-corpus-'))
    libraryDir = (await buildWritebackCorpus(join(root, 'corpus'))).libraryDir
  }, 120_000)
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('leaves track_tag_overrides empty and every file holding the value', async () => {
    const db = openDatabase(join(root, 'library.db')).db
    const service = new SqliteLibraryService({
      db,
      pickFolder: async () => libraryDir,
      onProgress: () => {}
    })
    const tagOverrideRows = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM track_tag_overrides').get() as { n: number }).n

    try {
      // Scan.
      const first = await service.addRoot()
      await service.scanRoot(first!.id)
      const ids = (
        db.prepare('SELECT id FROM tracks ORDER BY id').all() as Array<{ id: number }>
      ).map((row) => row.id)
      expect(ids.length).toBe(5)

      // Correct: one field of each editable kind, and a clear.
      const patch = {
        conductor: 'Nadia Boulanger',
        composers: ['Hildegard von Bingen', 'Arvo Pärt'],
        compilation: true,
        discTotal: 3,
        publisher: null
      } as const
      await service.setTagOverrides({ trackIds: ids, patch })
      expect(await service.pendingWritebackTrackIds()).toEqual(ids)

      // Flush everything the review shows, as the review would select it.
      const writeback = new TagWritebackService({
        differ: new TagWritebackDiffer(db),
        resolvePath: trackPathResolver(db),
        pendingTrackIds: () => service.pendingWritebackTrackIds(),
        retire: (trackId, fields) => service.retireWrittenOverrides(trackId, fields)
      })
      const pendings = await writeback.previewPending()
      expect(pendings.map((pending) => pending.trackId)).toEqual(ids)
      const report = await writeback.apply(
        pendings.map((pending) => ({
          trackId: pending.trackId,
          fields: Object.keys(pending.fields) as TagFieldKey[]
        })),
        () => {}
      )
      expect(report.failed, JSON.stringify(report.outcomes)).toBe(0)
      expect(report.written).toBe(5)
      expect(tagOverrideRows()).toBe(0)

      // Wipe, then rescan from nothing.
      await service.removeRoot(first!.id)
      expect((db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n).toBe(0)
      const second = await service.addRoot()
      await service.scanRoot(second!.id)

      expect(tagOverrideRows()).toBe(0)
      expect(await service.pendingWritebackTrackIds()).toEqual([])

      const keys = Object.keys(patch) as TagFieldKey[]
      const paths = (
        db.prepare('SELECT rel_path AS rel FROM tracks ORDER BY rel_path').all() as Array<{
          rel: string
        }>
      ).map((row) => join(libraryDir, row.rel))
      for (const path of paths) {
        const values = await readTagFields(path, keys)
        expect(Object.fromEntries(values), path).toEqual({
          conductor: 'Nadia Boulanger',
          composers: ['Hildegard von Bingen', 'Arvo Pärt'],
          compilation: true,
          discTotal: 3,
          publisher: null
        })
      }
    } finally {
      await service.close()
      db.close()
    }
  }, 120_000)
})
