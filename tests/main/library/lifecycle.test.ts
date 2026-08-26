import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import type { ArtworkImageProcessor } from '../../../src/main/library/artworkProcessor'
import type { TrackTags } from '../../../src/main/library/metadata'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'
import type { DirectoryWatchAdapter, WatchSubscription } from '../../../src/main/library/watcher'
import type { ListTracksQuery } from '../../../src/shared/library'

class FakeWatchAdapter implements DirectoryWatchAdapter {
  readonly entries = new Map<
    string,
    { event: (filename: string | null) => void; error: (error: unknown) => void }
  >()
  attempts = 0
  throwError: unknown = null

  watch(
    directory: string,
    onEvent: (filename: string | null) => void,
    onError: (error: unknown) => void
  ): WatchSubscription {
    this.attempts++
    if (this.throwError) throw this.throwError
    this.entries.set(directory, { event: onEvent, error: onError })
    return { close: () => this.entries.delete(directory) }
  }
}

class AcceptingArtworkProcessor implements ArtworkImageProcessor {
  async generate(): Promise<boolean> {
    return true
  }

  async validate(): Promise<boolean> {
    return false
  }

  async close(): Promise<void> {}
}

const query: ListTracksQuery = {
  sort: 'title',
  direction: 'asc',
  offset: 0,
  limit: 100
}

function tags(title: string): TrackTags {
  return {
    title,
    artist: null,
    album: null,
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    durationMs: 1_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre: null,
    replayGain: null
  }
}

let workDir: string
let root: string
let db: ReturnType<typeof openDatabase>['db']
let service: SqliteLibraryService

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'oscine-lifecycle-'))
  root = join(workDir, 'Music')
  mkdirSync(root)
  db = openDatabase(join(workDir, 'library.db')).db
})

afterEach(async () => {
  await service?.close()
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

function touch(relPath: string, contents = 'x'): string {
  const path = join(root, ...relPath.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  // Generous wall-clock budget: the reconciliation this polls for is fast
  // locally but competes for a slow, shared CI runner on Windows, where a tight
  // 1s deadline is the difference between a green run and a phantom failure.
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      await assertion()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

describe('incremental startup reconciliation', () => {
  it('does no metadata parses or track updates when nothing changed', async () => {
    touch('a.flac')
    const initialReader = vi.fn(async () => tags('A'))
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => root,
      onProgress: () => {},
      readMetadata: initialReader
    })
    const added = await service.addRoot()
    await service.scanRoot(added!.id)
    const before = db.prepare('SELECT id, mtime, size, title FROM tracks').get()
    await service.close()

    const startupReader = vi.fn(async () => tags('Should not be read'))
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => null,
      onProgress: () => {},
      readMetadata: startupReader,
      watchAdapter: new FakeWatchAdapter()
    })
    await service.initialize()

    expect(startupReader).not.toHaveBeenCalled()
    expect(db.prepare('SELECT id, mtime, size, title FROM tracks').get()).toEqual(before)
  })

  it('adds, reparses and deletes while retaining the id of a modified path', async () => {
    const a = touch('a.flac', 'a')
    const stale = touch('stale.flac', 'stale')
    const initialReader = vi.fn(async (path: string) => tags(readFileSync(path, 'utf8')))
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => root,
      onProgress: () => {},
      readMetadata: initialReader
    })
    const added = await service.addRoot()
    await service.scanRoot(added!.id)
    const originalId = (
      db.prepare("SELECT id FROM tracks WHERE rel_path = 'a.flac'").get() as { id: number }
    ).id
    await service.close()

    writeFileSync(a, 'changed')
    unlinkSync(stale)
    touch('new.flac', 'new')
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => null,
      onProgress: () => {},
      readMetadata: async (path) => tags(readFileSync(path, 'utf8')),
      watchAdapter: new FakeWatchAdapter()
    })
    await service.initialize()

    const tracks = (await service.listTracks(query)).tracks
    expect(tracks.map((track) => track.title)).toEqual(['changed', 'new'])
    expect(tracks.find((track) => track.title === 'changed')!.id).toBe(originalId)

    unlinkSync(join(root, 'new.flac'))
    await service.scanRoot(added!.id)
    expect((await service.listTracks(query)).tracks.map((track) => track.title)).toEqual([
      'changed'
    ])
  })
})

describe('live watcher reconciliation', () => {
  it('converges after add, modify, rename and delete bursts', async () => {
    touch('a.flac', 'a')
    const adapter = new FakeWatchAdapter()
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => root,
      onProgress: () => {},
      readMetadata: async (path) => tags(readFileSync(path, 'utf8')),
      watchAdapter: adapter,
      watchDebounceMs: 2,
      watchSettleMs: 0
    })
    const added = await service.addRoot()
    await service.scanRoot(added!.id)
    await service.initialize()
    const firstId = (await service.listTracks(query)).tracks[0].id

    touch('b.flac', 'b')
    adapter.entries.get(root)!.event('b.flac')
    await eventually(async () => {
      expect((await service.listTracks(query)).tracks.map((track) => track.title)).toEqual([
        'a',
        'b'
      ])
    })

    writeFileSync(join(root, 'a.flac'), 'changed-a')
    adapter.entries.get(root)!.event('a.flac')
    await eventually(async () => {
      const tracks = (await service.listTracks(query)).tracks
      expect(tracks.map((track) => track.title)).toContain('changed-a')
      expect(tracks.find((track) => track.title === 'changed-a')!.id).toBe(firstId)
    })

    renameSync(join(root, 'b.flac'), join(root, 'c.flac'))
    writeFileSync(join(root, 'c.flac'), 'c')
    adapter.entries.get(root)!.event('b.flac')
    adapter.entries.get(root)!.event('c.flac')
    await eventually(async () => {
      expect((await service.listTracks(query)).tracks.map((track) => track.title)).toEqual([
        'c',
        'changed-a'
      ])
    })

    unlinkSync(join(root, 'c.flac'))
    adapter.entries.get(root)!.event('c.flac')
    await eventually(async () => {
      expect((await service.listTracks(query)).tracks.map((track) => track.title)).toEqual([
        'changed-a'
      ])
      expect(
        (
          await service.listTracks({
            ...query,
            searchText: 'changed'
          })
        ).total
      ).toBe(1)
    })
  })

  it('records ENOSPC degradation, emits one actionable notice, and never retries', async () => {
    touch('a.flac')
    const adapter = new FakeWatchAdapter()
    adapter.throwError = Object.assign(new Error('inotify full'), { code: 'ENOSPC' })
    const notices: unknown[] = []
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => root,
      onProgress: () => {},
      onNotice: (notice) => notices.push(notice),
      readMetadata: async () => tags('a'),
      watchAdapter: adapter
    })
    const added = await service.addRoot()
    await service.scanRoot(added!.id)
    await service.initialize()

    expect((await service.listRoots())[0].watchMode).toBe('startup-scan-only')
    expect(notices).toEqual([
      expect.objectContaining({
        kind: 'watch-degraded',
        rootId: added!.id,
        code: 'ENOSPC',
        message: expect.stringContaining('fs.inotify.max_user_watches')
      })
    ])
    const attempts = adapter.attempts

    await service.scanRoot(added!.id)
    expect(adapter.attempts).toBe(attempts)
    expect(notices).toHaveLength(1)
  })

  it('reconciles an album when a sidecar image is added or removed', async () => {
    touch('Album/a.flac', 'a')
    const adapter = new FakeWatchAdapter()
    const artworkAtDone: Array<string | null> = []
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => root,
      onProgress: (progress) => {
        if (!progress.done) return
        const row = db
          .prepare("SELECT artwork_hash AS hash FROM albums WHERE title = 'Album'")
          .get() as { hash: string | null } | undefined
        artworkAtDone.push(row?.hash ?? null)
      },
      readMetadata: async () => ({ ...tags('a'), album: 'Album', artist: 'Artist' }),
      artworkCacheDir: join(workDir, 'artwork'),
      readArtwork: async () => [],
      artworkProcessor: new AcceptingArtworkProcessor(),
      watchAdapter: adapter,
      watchDebounceMs: 2,
      watchSettleMs: 0
    })
    const added = await service.addRoot()
    await service.scanRoot(added!.id)
    await service.initialize()
    const artworkHash = (): string | null =>
      (
        db.prepare("SELECT artwork_hash AS hash FROM albums WHERE title = 'Album'").get() as {
          hash: string | null
        }
      ).hash
    expect(artworkHash()).toBeNull()

    const cover = touch('Album/Folder.JPG', 'cover')
    adapter.entries.get(join(root, 'Album'))!.event('Folder.JPG')
    // artworkHash() reads the DB directly; artworkAtDone is captured in the
    // onProgress(done) callback. These are two independent observations of the
    // same reconciliation, so the DB write can land a poll before the callback
    // fires — assert both inside eventually rather than sampling the callback
    // once, or a slow runner reads the stale previous value.
    await eventually(async () => {
      expect(artworkHash()).not.toBeNull()
      expect(artworkAtDone.at(-1)).not.toBeNull()
    })

    unlinkSync(cover)
    adapter.entries.get(join(root, 'Album'))!.event('Folder.JPG')
    await eventually(async () => {
      expect(artworkHash()).toBeNull()
      expect(artworkAtDone.at(-1)).toBeNull()
    })
  })
})
