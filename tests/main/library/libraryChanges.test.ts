import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import {
  createLibraryChangeNotifier,
  currentChangeOrigin,
  withChangeOrigin,
  type LibraryChangeNotifier
} from '../../../src/main/library/changes'
import { SqlitePlaylistService } from '../../../src/main/library/playlists/service'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'
import { TagStore } from '../../../src/main/tags/store'
import type { LibraryChanged } from '@shared/libraryChanges'
import { mergeLibraryChanges } from '@shared/libraryChanges'

/**
 * `library.changed` — **D36.9**, W24-3. The coalescing rule is the point: one
 * event per committed service call, never one per row, so a bulk write cannot
 * flood the renderer the way unthrottled progress once froze Cancel.
 */

const BULK = 500

describe('mergeLibraryChanges', () => {
  it('unions ids per kind, lets all absorb a list, and drops empty kinds', () => {
    expect(
      mergeLibraryChanges(
        { overrides: [1, 2], tags: [3], playlists: [] },
        { overrides: [2, 4], tags: 'all' }
      )
    ).toEqual({ overrides: [1, 2, 4], tags: 'all' })
  })
})

describe('LibraryChangeNotifier', () => {
  let events: LibraryChanged[]
  let notifier: LibraryChangeNotifier

  beforeEach(() => {
    events = []
    notifier = createLibraryChangeNotifier({ emit: (event) => events.push(event) })
  })

  it('sends one event per notify, stamped main outside any caller', () => {
    notifier.notify({ overrides: [1, 1, 2] })
    expect(events).toEqual([{ origin: 'main', changes: { overrides: [1, 2] } }])
  })

  it('stamps the origin of the code that made the write', async () => {
    await withChangeOrigin('agent', async () => {
      await Promise.resolve()
      expect(currentChangeOrigin()).toBe('agent')
      notifier.notify({ tags: [5] })
    })
    withChangeOrigin('renderer', () => notifier.notify({ playlists: [1] }))
    expect(events.map((event) => event.origin)).toEqual(['agent', 'renderer'])
  })

  it('drops a change set that names nothing', () => {
    notifier.notify({})
    notifier.notify({ overrides: [] })
    expect(events).toEqual([])
  })

  it('merges everything inside a batch, nested batches included, into one event', async () => {
    await notifier.batch(async () => {
      notifier.notify({ overrides: [1] })
      await Promise.resolve()
      await notifier.batch(async () => notifier.notify({ tagOverrides: [2] }))
      notifier.notify({ overrides: [3] })
      expect(events).toEqual([])
    })
    expect(events).toEqual([{ origin: 'main', changes: { overrides: [1, 3], tagOverrides: [2] } }])
  })

  it('still sends what a batch committed before it threw', async () => {
    await expect(
      notifier.batch(async () => {
        notifier.notify({ overrides: [7] })
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(events).toEqual([{ origin: 'main', changes: { overrides: [7] } }])
  })

  it('never fails the write when the send throws', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = createLibraryChangeNotifier({
      emit: () => {
        throw new Error('window gone')
      }
    })
    expect(() => broken.notify({ overrides: [1] })).not.toThrow()
    quiet.mockRestore()
  })
})

describe('write services announce once per call', () => {
  let dir: string
  let db: Database.Database
  let events: LibraryChanged[]
  let changes: LibraryChangeNotifier
  let trackIds: number[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-library-changes-'))
    db = openDatabase(join(dir, 'library.db')).db
    events = []
    changes = createLibraryChangeNotifier({ emit: (event) => events.push(event) })
    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', join(dir, 'music'), 1).lastInsertRowid
    )
    const insert = db.prepare(
      'INSERT INTO tracks (root_id, rel_path, mtime, size, title) VALUES (?, ?, 1, 1, ?)'
    )
    trackIds = db.transaction(() =>
      Array.from({ length: BULK }, (_, i) =>
        Number(insert.run(rootId, `t${i}.flac`, `Track ${i}`).lastInsertRowid)
      )
    )()
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function library(): SqliteLibraryService {
    return new SqliteLibraryService({
      db,
      changes,
      pickFolder: async () => null,
      onProgress: () => {},
      // Unreadable: a revert keeps its correction rather than guess.
      readMetadata: async () => {
        throw new Error('no file')
      }
    })
  }

  it('a 500-track override set is one event naming every track', async () => {
    await library().setOverrides({ trackIds, patch: { artist: 'Corrected' } })
    expect(events).toHaveLength(1)
    expect(events[0].origin).toBe('main')
    expect([...(events[0].changes.overrides as number[])].sort((a, b) => a - b)).toEqual(trackIds)
  })

  it('a 500-track generic correction and its revert are one event each', async () => {
    const service = library()
    await service.setTagOverrides({ trackIds, patch: { conductor: 'Someone' } })
    await service.revertTagOverrides({ trackIds, fields: ['conductor'] })
    expect(events).toHaveLength(2)
    for (const event of events) expect(event.changes.tagOverrides).toHaveLength(BULK)
  })

  it('discarding every correction is one event however many steps it takes', async () => {
    const service = library()
    await service.setOverrides({ trackIds: trackIds.slice(0, 3), patch: { title: 'X' } })
    await service.setTagOverrides({ trackIds: trackIds.slice(0, 2), patch: { conductor: 'Y' } })
    events.length = 0
    await service.discardAllOverrides()
    expect(events).toHaveLength(1)
    expect(events[0].changes.tagOverrides).toBe('all')
    expect(events[0].changes.overrides).toEqual(trackIds.slice(0, 3))
  })

  it('a 500-track playlist add is one event naming the playlist', async () => {
    const playlists = new SqlitePlaylistService({ db, changes, pickExportFile: async () => null })
    const created = await playlists.create('Mix')
    events.length = 0
    await playlists.addTracks({ playlistId: created.id, trackIds, insertion: { at: 'end' } })
    expect(events).toEqual([
      { origin: 'main', changes: { playlists: [created.id], playlistEntries: [created.id] } }
    ])
  })

  it('a 500-track tag add is one event; a rename names every track; a no-op is silent', () => {
    const tags = new TagStore(db, changes)
    const tag = tags.addTag(trackIds, 'Late Night', 'user')
    expect(events).toHaveLength(1)
    expect(events[0].changes.tags).toHaveLength(BULK)

    tags.renameTag(tag!.id, 'Late-night')
    expect(events[1].changes).toEqual({ tags: 'all' })

    const other = tags.addTag([trackIds[0]], 'Other', 'user')
    events.length = 0
    tags.removeTag([trackIds[1]], other!.id)
    expect(events).toEqual([])
  })

  it('a renderer-made write says so', async () => {
    await withChangeOrigin('renderer', () =>
      library().setOverrides({ trackIds: [trackIds[0]], patch: { title: 'Mine' } })
    )
    expect(events[0].origin).toBe('renderer')
  })
})
