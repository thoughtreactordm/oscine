import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FermataError } from '../../../src/shared/errors'
import type { ScanProgress } from '../../../src/shared/library'
import { openDatabase } from '../../../src/main/db'
import type { MetadataReader, TrackTags } from '../../../src/main/library/metadata'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'

/**
 * The add-root flow, driven exactly as `library.addRoot` drives it.
 *
 * The picker and the progress channel are the service's only Electron
 * dependencies and both arrive as functions, so the whole flow runs here with a
 * temp folder and no application.
 */

let workDir: string
let db: ReturnType<typeof openDatabase>['db']
let picked: string | null
let progress: ScanProgress[]
let service: SqliteLibraryService

function tags(overrides: Partial<TrackTags> = {}): TrackTags {
  return {
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    durationMs: 200_000,
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    replayGain: null,
    ...overrides
  }
}

const readAnything: MetadataReader = async () => tags()

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fermata-svc-'))
  db = openDatabase(join(workDir, 'library.db')).db
  picked = null
  progress = []
  service = new SqliteLibraryService({
    db,
    pickFolder: async () => picked,
    onProgress: (event) => progress.push(event),
    readMetadata: readAnything
  })
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

/** Creates a music folder under the temp dir and returns its absolute path. */
function musicFolder(name: string, relFiles: string[] = []): string {
  const root = join(workDir, name)
  mkdirSync(root, { recursive: true })
  for (const rel of relFiles) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, 'x')
  }
  return root
}

/**
 * Adds a root and waits for the scan `addRoot` kicked off.
 *
 * `scanRoot` returns the in-flight promise rather than starting a second scan,
 * which is what makes the background scan awaitable at all.
 */
async function addAndScan(path: string) {
  picked = path
  const root = await service.addRoot()
  if (root) await service.scanRoot(root.id)
  return root
}

describe('addRoot', () => {
  it('inserts the picked folder and reports it back', async () => {
    const path = musicFolder('Music', ['a.flac'])
    picked = path

    const root = await service.addRoot()

    expect(root).not.toBeNull()
    expect(root!.path).toBe(path)
    expect(root!.trackCount).toBe(0) // The scan has only just started.
    expect(Date.parse(root!.addedAt)).not.toBeNaN()
  })

  it('returns null when the user cancels, rather than failing', async () => {
    picked = null
    expect(await service.addRoot()).toBeNull()
    expect(await service.listRoots()).toEqual([])
  })

  it('scans in the background and reports progress', async () => {
    const path = musicFolder('Music', ['a.flac', 'Artist/b.flac'])

    const root = await addAndScan(path)

    expect((await service.listRoots())[0].trackCount).toBe(2)
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress[progress.length - 1]).toMatchObject({
      rootId: root!.id,
      done: true,
      filesSeen: 2,
      tracksIndexed: 2
    })
  })

  it('normalises the picked path before storing it', async () => {
    const path = musicFolder('Music', ['a.flac'])
    // Pickers and drag-and-drop do not deliver a canonical form.
    picked = join(path, 'Artist', '..') + sep

    const root = await service.addRoot()

    expect(root!.path).toBe(path)
  })

  it('refuses a path that is not a directory', async () => {
    const path = musicFolder('Music', ['a.flac'])
    picked = join(path, 'a.flac')

    await expect(service.addRoot()).rejects.toThrow(FermataError)
  })

  it('refuses a folder that is not there', async () => {
    picked = join(workDir, 'nowhere')
    await expect(service.addRoot()).rejects.toThrow(FermataError)
  })
})

/**
 * Re-adding a root must be rejected cleanly, per the card's acceptance.
 *
 * `roots.path` being UNIQUE only catches a byte-identical string. Every case
 * below slips past it and would index the same files twice.
 */
describe('addRoot conflict handling', () => {
  async function expectConflict(path: string): Promise<FermataError> {
    picked = path
    const error = await service.addRoot().then(
      () => null,
      (err: unknown) => err
    )

    expect(error).toBeInstanceOf(FermataError)
    expect((error as FermataError).code).toBe('conflict')
    return error as FermataError
  }

  it('rejects the identical folder', async () => {
    const path = musicFolder('Music', ['a.flac'])
    await addAndScan(path)

    await expectConflict(path)

    expect(await service.listRoots()).toHaveLength(1)
  })

  it('rejects the same folder spelled differently', async () => {
    const path = musicFolder('Music', ['a.flac'])
    await addAndScan(path)

    await expectConflict(path + sep)
    await expectConflict(join(path, 'Artist', '..'))

    expect(await service.listRoots()).toHaveLength(1)
  })

  it('rejects a folder nested inside an existing root', async () => {
    const path = musicFolder('Music', ['Artist/a.flac'])
    await addAndScan(path)

    const error = await expectConflict(join(path, 'Artist'))

    expect(error.message).toMatch(/inside/i)
    expect(await service.listRoots()).toHaveLength(1)
  })

  it('rejects a folder that would swallow an existing root', async () => {
    const path = musicFolder('Outer/Inner', ['a.flac'])
    await addAndScan(path)

    const error = await expectConflict(join(workDir, 'Outer'))

    expect(error.message).toMatch(/contains/i)
    expect(await service.listRoots()).toHaveLength(1)
  })

  it('accepts a genuinely separate folder', async () => {
    await addAndScan(musicFolder('Music', ['a.flac']))
    await addAndScan(musicFolder('Podcasts', ['b.flac']))

    expect(await service.listRoots()).toHaveLength(2)
  })

  it('does not mistake a sibling sharing a name prefix for an overlap', async () => {
    await addAndScan(musicFolder('Music', ['a.flac']))
    await addAndScan(musicFolder('Music Archive', ['b.flac']))

    expect(await service.listRoots()).toHaveLength(2)
  })
})

describe('scanRoot', () => {
  it('shares one scan rather than starting a second for the same root', async () => {
    const path = musicFolder('Music', ['a.flac', 'b.flac'])
    picked = path
    const root = await service.addRoot()

    // Both of these join the scan `addRoot` already started.
    const [first, second] = await Promise.all([
      service.scanRoot(root!.id),
      service.scanRoot(root!.id)
    ])

    expect(first).toEqual(second)
    expect(first.tracksIndexed).toBe(2)
    // Two concurrent scans would have written every row twice over.
    expect((await service.listRoots())[0].trackCount).toBe(2)
  })

  it('can be run again once the first has finished', async () => {
    const path = musicFolder('Music', ['a.flac'])
    await addAndScan(path)

    const summary = await service.scanRoot((await service.listRoots())[0].id)

    expect(summary.tracksIndexed).toBe(1)
    expect((await service.listRoots())[0].trackCount).toBe(1)
  })

  it('rejects an unknown root without crashing the caller', async () => {
    await expect(service.scanRoot(4242)).rejects.toThrow(FermataError)
  })
})

describe('listTracks', () => {
  async function seed(): Promise<void> {
    const path = musicFolder('Music', ['c.flac', 'a.flac', 'b.flac'])
    const byName: Record<string, TrackTags> = {
      'b.flac': tags({
        title: 'Beacon',
        artist: 'Aphex Twin',
        album: 'Selected Ambient Works',
        durationMs: 100_000,
        trackNo: 1
      }),
      'c.flac': tags({
        title: 'Cirrus',
        artist: 'Boards of Canada',
        album: 'Geogaddi',
        durationMs: 200_000,
        trackNo: 2
      }),
      'a.flac': tags({
        title: 'Anthem',
        artist: 'Zoviet France',
        album: 'Shouting at the Ground',
        durationMs: 300_000,
        trackNo: 3
      })
    }

    service = new SqliteLibraryService({
      db,
      pickFolder: async () => path,
      onProgress: () => {},
      readMetadata: async (absPath) => byName[absPath.split(/[\\/]/).pop()!] ?? tags()
    })

    const root = await service.addRoot()
    await service.scanRoot(root!.id)
  }

  it('sorts by title and reports the unpaginated total', async () => {
    await seed()

    const result = await service.listTracks({
      sort: 'title',
      direction: 'asc',
      offset: 0,
      limit: 10
    })

    expect(result.total).toBe(3)
    expect(result.tracks.map((track) => track.title)).toEqual(['Anthem', 'Beacon', 'Cirrus'])
    // The renderer needs this before fetching so the R1 guard can include the
    // encoded ArrayBuffer in its decode-transient admission cost.
    expect(result.tracks.map((track) => track.encodedBytes)).toEqual([1, 1, 1])
  })

  it('sorts descending, and by other columns', async () => {
    await seed()

    const byArtist = await service.listTracks({
      sort: 'artist',
      direction: 'asc',
      offset: 0,
      limit: 10
    })
    expect(byArtist.tracks.map((track) => track.artist)).toEqual([
      'Aphex Twin',
      'Boards of Canada',
      'Zoviet France'
    ])

    const byDuration = await service.listTracks({
      sort: 'durationSec',
      direction: 'desc',
      offset: 0,
      limit: 10
    })
    expect(byDuration.tracks.map((track) => track.durationSec)).toEqual([300, 200, 100])

    const byAlbum = await service.listTracks({
      sort: 'album',
      direction: 'asc',
      offset: 0,
      limit: 10
    })
    expect(byAlbum.tracks.map((track) => track.album)).toEqual([
      'Geogaddi',
      'Selected Ambient Works',
      'Shouting at the Ground'
    ])
  })

  it('pages without dropping or repeating a row', async () => {
    await seed()

    const first = await service.listTracks({
      sort: 'trackNo',
      direction: 'asc',
      offset: 0,
      limit: 2
    })
    const second = await service.listTracks({
      sort: 'trackNo',
      direction: 'asc',
      offset: 2,
      limit: 2
    })

    expect(first.tracks.map((track) => track.title)).toEqual(['Beacon', 'Cirrus'])
    expect(second.tracks.map((track) => track.title)).toEqual(['Anthem'])
    expect(first.total).toBe(3)
  })

  it('scopes to a root when asked', async () => {
    await seed()
    const [root] = await service.listRoots()

    for (const sort of ['title', 'artist', 'album'] as const) {
      const mine = await service.listTracks({
        rootId: root.id,
        sort,
        direction: 'asc',
        offset: 0,
        limit: 10
      })
      const other = await service.listTracks({
        rootId: root.id + 999,
        sort,
        direction: 'asc',
        offset: 0,
        limit: 10
      })

      expect(mine.total).toBe(3)
      expect(other.total).toBe(0)
      expect(other.tracks).toEqual([])
    }
  })

  it('never exposes a filesystem path to the renderer', async () => {
    await seed()

    const { tracks } = await service.listTracks({
      sort: 'title',
      direction: 'asc',
      offset: 0,
      limit: 10
    })

    // The pathless `Track` is what keeps the renderer from gaining an
    // arbitrary-file-read primitive; a stray join could undo it silently.
    for (const track of tracks) {
      expect(Object.keys(track)).not.toContain('path')
      expect(Object.keys(track)).not.toContain('relPath')
      expect(JSON.stringify(track)).not.toContain(workDir)
    }
  })

  it('sorts untagged rows last in both directions', async () => {
    const path = musicFolder('Music', ['tagged.flac', 'bare.flac'])
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => path,
      onProgress: () => {},
      readMetadata: async (absPath) =>
        absPath.endsWith('tagged.flac')
          ? tags({ artist: 'Autechre', album: 'Tri Repetae' })
          : tags()
    })
    const root = await service.addRoot()
    await service.scanRoot(root!.id)

    for (const sort of ['artist', 'album'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const { tracks } = await service.listTracks({
          sort,
          direction,
          offset: 0,
          limit: 10
        })
        expect(tracks[tracks.length - 1][sort]).toBeNull()
      }
    }
  })

  it('keeps joined-sort ties stable and pages across the null tail', async () => {
    const path = musicFolder('Music', [
      '01-upper.flac',
      '02-lower.flac',
      '03-zulu.flac',
      '04-bare.flac',
      '05-bare.flac'
    ])
    const byName: Record<string, TrackTags> = {
      '01-upper.flac': tags({ artist: 'Alpha', album: 'Echo' }),
      '02-lower.flac': tags({ artist: 'alpha', album: 'echo' }),
      '03-zulu.flac': tags({ artist: 'Zulu', album: 'Zulu' }),
      '04-bare.flac': tags(),
      '05-bare.flac': tags()
    }
    service = new SqliteLibraryService({
      db,
      pickFolder: async () => path,
      onProgress: () => {},
      readMetadata: async (absPath) => byName[absPath.split(/[\\/]/).pop()!] ?? tags()
    })
    const root = await service.addRoot()
    await service.scanRoot(root!.id)

    for (const sort of ['artist', 'album'] as const) {
      const full = await service.listTracks({
        sort,
        direction: 'asc',
        offset: 0,
        limit: 10
      })
      const tied = full.tracks.slice(0, 2)
      expect(tied.map((track) => track.id)).toEqual(
        tied.map((track) => track.id).toSorted((a, b) => a - b)
      )
      expect(full.tracks.slice(3).map((track) => track[sort])).toEqual([null, null])

      const crossing = await service.listTracks({
        sort,
        direction: 'asc',
        offset: 2,
        limit: 3
      })
      expect(crossing.tracks.map((track) => track.id)).toEqual(
        full.tracks.slice(2, 5).map((track) => track.id)
      )
    }
  })
})

describe('resolveTrackPath', () => {
  it('resolves a track id to the file it came from', async () => {
    const path = musicFolder('Music', ['Artist/Album/a.flac'])
    await addAndScan(path)

    const { tracks } = await service.listTracks({
      sort: 'title',
      direction: 'asc',
      offset: 0,
      limit: 10
    })

    expect(await service.resolveTrackPath(tracks[0].id)).toBe(
      join(path, 'Artist', 'Album', 'a.flac')
    )
  })

  it('returns null for an unknown id rather than throwing', async () => {
    // The `fermata://` handler turns this into a 404.
    expect(await service.resolveTrackPath(4242)).toBeNull()
  })
})
