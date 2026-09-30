import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import {
  commitRipPart,
  ingestRippedTracks,
  MAX_RIP_COLLISION_SUFFIX,
  placeRipDest
} from '../../../src/main/cdrip/ingest'
import type { MetadataReader, TrackTags } from '../../../src/main/library/metadata'
import { LibraryStore } from '../../../src/main/library/store'

/**
 * Rip ingest — W18-6. Collision, same-directory rename, and the explicit
 * reconcile that must not depend on the watcher.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rip-ingest-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function resolvePath(_rootId: number, relPath: string): string {
  return join(dir, ...relPath.split('/'))
}

function audioTags(overrides: Partial<TrackTags> = {}): TrackTags {
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
    genre: null,
    lyrics: null,
    replayGain: null,
    ...overrides
  }
}

describe('commitRipPart', () => {
  it('renames a same-directory .part onto the final name and removes the part', async () => {
    const finalAbs = join(dir, '01 Track.flac')
    const partPath = `${finalAbs}.deadbeef.part`
    writeFileSync(partPath, 'flac')

    expect(dirname(partPath)).toBe(dirname(finalAbs))
    await commitRipPart(partPath, finalAbs, false)

    expect(existsSync(partPath)).toBe(false)
    expect(readFileSync(finalAbs, 'utf8')).toBe('flac')
  })

  it('refuses a part that is not a sibling of the destination', async () => {
    const nested = join(dir, 'nested')
    mkdirSync(nested)
    const finalAbs = join(dir, '01 Track.flac')
    const partPath = join(nested, '01 Track.flac.deadbeef.part')
    writeFileSync(partPath, 'flac')

    await expect(commitRipPart(partPath, finalAbs, false)).rejects.toThrow(/not a sibling/)
    expect(existsSync(partPath)).toBe(true)
    expect(existsSync(finalAbs)).toBe(false)
  })
})

describe('placeRipDest', () => {
  it('leaves an existing file untouched and reports skip', async () => {
    const relPath = '01 Track 1.flac'
    const absPath = resolvePath(1, relPath)
    writeFileSync(absPath, 'existing')

    const placed = await placeRipDest({
      onCollision: 'skip',
      rootId: 1,
      relPath,
      absPath,
      resolvePath
    })

    expect(placed).toBe('skip')
    expect(readFileSync(absPath, 'utf8')).toBe('existing')
  })

  it('overwrite keeps the existing path so the later rename can replace it', async () => {
    const relPath = '01 Track 1.flac'
    const absPath = resolvePath(1, relPath)
    writeFileSync(absPath, 'existing')

    const placed = await placeRipDest({
      onCollision: 'overwrite',
      rootId: 1,
      relPath,
      absPath,
      resolvePath
    })

    expect(placed).toEqual({ relPath, absPath })
    expect(readFileSync(absPath, 'utf8')).toBe('existing')

    const partPath = `${absPath}.cafe.part`
    writeFileSync(partPath, 'ripped')
    await commitRipPart(partPath, absPath, true)

    expect(readFileSync(absPath, 'utf8')).toBe('ripped')
    expect(existsSync(partPath)).toBe(false)
  })

  it('suffix produces (2) beside the original and does not loop forever', async () => {
    const relPath = 'Artist/Album/01 Title.flac'
    mkdirSync(join(dir, 'Artist', 'Album'), { recursive: true })
    writeFileSync(resolvePath(1, relPath), 'one')
    writeFileSync(resolvePath(1, 'Artist/Album/01 Title (2).flac'), 'two')

    const placed = await placeRipDest({
      onCollision: 'suffix',
      rootId: 1,
      relPath,
      absPath: resolvePath(1, relPath),
      resolvePath
    })

    expect(placed).toEqual({
      relPath: 'Artist/Album/01 Title (3).flac',
      absPath: resolvePath(1, 'Artist/Album/01 Title (3).flac')
    })
    expect(readFileSync(resolvePath(1, relPath), 'utf8')).toBe('one')

    const taken = '01 Packed.flac'
    writeFileSync(resolvePath(1, taken), 'x')
    for (let n = 2; n <= MAX_RIP_COLLISION_SUFFIX; n++) {
      writeFileSync(resolvePath(1, `01 Packed (${n}).flac`), 'x')
    }
    await expect(
      placeRipDest({
        onCollision: 'suffix',
        rootId: 1,
        relPath: taken,
        absPath: resolvePath(1, taken),
        resolvePath
      })
    ).rejects.toThrow(/collision suffix exhausted/)
  })
})

describe('ingestRippedTracks', () => {
  let workDir: string
  let musicDir: string
  let db: ReturnType<typeof openDatabase>['db']
  let store: LibraryStore
  let rootId: number

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'oscine-rip-index-'))
    musicDir = join(workDir, 'Music')
    mkdirSync(musicDir)
    db = openDatabase(join(workDir, 'library.db')).db
    store = new LibraryStore(db)
    rootId = store.insertRoot(musicDir, 'Music', Date.now()).id
  })

  afterEach(() => {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  function touch(relPath: string, body = 'x'): string {
    const abs = join(musicDir, ...relPath.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
    return abs
  }

  function readerFor(byRelPath: Record<string, TrackTags>): MetadataReader {
    return async (absPath) => {
      const rel = absPath
        .slice(musicDir.length + 1)
        .split(/[\\/]/)
        .join('/')
      return byRelPath[rel] ?? audioTags()
    }
  }

  function trackRows(): Array<{ id: number; relPath: string; indexedAt: number | null }> {
    return db
      .prepare(
        `SELECT id, rel_path AS relPath, indexed_at AS indexedAt FROM tracks ORDER BY rel_path`
      )
      .all() as Array<{ id: number; relPath: string; indexedAt: number | null }>
  }

  it('indexes exactly the ripped paths and stores POSIX-relative rows', async () => {
    const ripped = touch('Boards of Canada/Geogaddi/03 Julie and Candy.flac')
    touch('other.flac')

    const reads: string[] = []
    const ids = await ingestRippedTracks(store, { id: rootId, path: musicDir }, [ripped], {
      readMetadata: async (absPath) => {
        reads.push(absPath)
        return readerFor({
          'Boards of Canada/Geogaddi/03 Julie and Candy.flac': audioTags({
            title: 'Julie and Candy',
            artist: 'Boards of Canada',
            album: 'Geogaddi'
          })
        })(absPath)
      }
    })

    expect(reads).toEqual([ripped])
    const rows = trackRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: ids[0],
      relPath: 'Boards of Canada/Geogaddi/03 Julie and Candy.flac'
    })
    expect(rows[0]!.relPath).not.toMatch(/\\/)
    expect(rows[0]!.relPath.startsWith('/')).toBe(false)
    expect(rows[0]!.relPath).not.toMatch(/^[A-Za-z]:/)
    expect(ids).toEqual([rows[0]!.id])
  })

  it('is a no-op on a second pass of the same files', async () => {
    const ripped = touch('01 Track.flac')
    const deps = { readMetadata: readerFor({ '01 Track.flac': audioTags({ title: 'Track' }) }) }

    const first = await ingestRippedTracks(store, { id: rootId, path: musicDir }, [ripped], deps)
    const afterFirst = trackRows()
    const second = await ingestRippedTracks(store, { id: rootId, path: musicDir }, [ripped], deps)
    const afterSecond = trackRows()

    expect(second).toEqual(first)
    expect(afterSecond).toEqual(afterFirst)
    expect(afterSecond[0]?.relPath).toBe('01 Track.flac')
  })
})
