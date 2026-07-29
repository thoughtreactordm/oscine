import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { ArtworkCacheService } from '../../../src/main/library/artwork'
import type { ArtworkImageProcessor } from '../../../src/main/library/artworkProcessor'
import type {
  EmbeddedArtwork,
  EmbeddedArtworkReader,
  TrackTags
} from '../../../src/main/library/metadata'
import { LibraryStore } from '../../../src/main/library/store'

let dir: string
let cacheDir: string
let db: ReturnType<typeof openDatabase>['db']
let store: LibraryStore
let rootId: number

class FakeProcessor implements ArtworkImageProcessor {
  active = 0
  maxActive = 0
  calls = 0

  async generate(cache: string, hash: string, bytes: Uint8Array): Promise<boolean> {
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    this.calls++
    try {
      await yieldToEventLoop()
      if (Buffer.from(bytes).toString() === 'malformed') {
        throw new Error('unsupported image')
      }
      await mkdir(cache, { recursive: true })
      let generated = false
      for (const variant of ['small', 'large']) {
        const path = join(cache, `${hash}-${variant}.webp`)
        const expected = `${variant}:${hash}`
        try {
          if ((await readFile(path, 'utf8')) !== expected) {
            await writeFile(path, expected)
            generated = true
          }
        } catch {
          await writeFile(path, expected)
          generated = true
        }
      }
      return generated
    } finally {
      this.active--
    }
  }

  async validate(cache: string, hash: string): Promise<boolean> {
    try {
      for (const variant of ['small', 'large']) {
        const value = await readFile(join(cache, `${hash}-${variant}.webp`), 'utf8')
        if (value !== `${variant}:${hash}`) return false
      }
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {}
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-artwork-'))
  cacheDir = join(dir, 'cache')
  db = openDatabase(join(dir, 'library.db')).db
  store = new LibraryStore(db)
  rootId = store.insertRoot(join(dir, 'music'), 'music', Date.now()).id
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function tags(album: string, artist: string): TrackTags {
  return {
    title: null,
    artist,
    album,
    albumArtist: artist,
    trackNo: null,
    discNo: null,
    year: null,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    replayGain: null
  }
}

function addTrack(relPath: string, album: string, artist: string): string {
  const absPath = join(dir, 'music', ...relPath.split('/'))
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, 'audio')
  store.writeTracks(rootId, [
    {
      file: { absPath, relPath, mtime: 1, size: 5 },
      tags: tags(album, artist)
    }
  ])
  return absPath
}

function picture(value: string, index = 0): EmbeddedArtwork {
  return {
    index,
    format: 'image/png',
    type: 'Cover (front)',
    bytes: Buffer.from(value)
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function albumHash(title: string): string | null {
  return (
    db.prepare('SELECT artwork_hash AS artworkHash FROM albums WHERE title = ?').get(title) as {
      artworkHash: string | null
    }
  ).artworkHash
}

function reader(entries: Map<string, EmbeddedArtwork[]>): EmbeddedArtworkReader {
  return async (path) => entries.get(path) ?? []
}

describe('ArtworkCacheService', () => {
  it('deduplicates identical bytes and returns only opaque bounded-variant URLs', async () => {
    const first = addTrack('A/01.flac', 'First', 'Artist A')
    const second = addTrack('B/01.flac', 'Second', 'Artist B')
    const processor = new FakeProcessor()
    const service = new ArtworkCacheService({
      store,
      cacheDir,
      processor,
      readArtwork: reader(
        new Map([
          [first, [picture('same-cover')]],
          [second, [picture('same-cover')]]
        ])
      )
    })

    const metrics = await service.reconcile(undefined, true)
    const expectedHash = hash('same-cover')

    expect(albumHash('First')).toBe(expectedHash)
    expect(albumHash('Second')).toBe(expectedHash)
    expect(processor.calls).toBe(1)
    expect(processor.maxActive).toBeLessThanOrEqual(2)
    expect(metrics.cacheFiles).toBe(2)
    expect(metrics.concurrency).toBe(2)

    const albums = store.listAlbums({ offset: 0, limit: 10 }).albums
    expect(albums[0].artwork.small).toMatch(new RegExp(`^fermata://artwork/${expectedHash}/small$`))
    expect(albums[0].artwork.large).toMatch(new RegExp(`^fermata://artwork/${expectedHash}/large$`))
    expect(JSON.stringify(albums)).not.toContain(dir)
  })

  it('walks deterministic candidates past missing and malformed pictures', async () => {
    const first = addTrack('Album/01.flac', 'Album', 'Artist')
    const second = addTrack('Album/02.flac', 'Album', 'Artist')
    const service = new ArtworkCacheService({
      store,
      cacheDir,
      processor: new FakeProcessor(),
      readArtwork: reader(
        new Map([
          [first, [picture('malformed')]],
          [second, [picture('valid-cover')]]
        ])
      )
    })

    await expect(service.reconcile(undefined, true)).resolves.toBeDefined()
    expect(albumHash('Album')).toBe(hash('valid-cover'))
  })

  it('updates changed art, prunes unreferenced variants, and self-heals corruption', async () => {
    const track = addTrack('Album/01.flac', 'Album', 'Artist')
    const pictures = new Map([[track, [picture('old-cover')]]])
    const processor = new FakeProcessor()
    const service = new ArtworkCacheService({
      store,
      cacheDir,
      processor,
      readArtwork: reader(pictures)
    })

    await service.reconcile(undefined, true)
    const oldHash = hash('old-cover')
    pictures.set(track, [picture('new-cover')])
    await service.reconcile(undefined, true)
    const newHash = hash('new-cover')

    expect(albumHash('Album')).toBe(newHash)
    await expect(readFile(join(cacheDir, `${oldHash}-small.webp`))).rejects.toThrow()

    await writeFile(join(cacheDir, `${newHash}-large.webp`), 'corrupt')
    await service.reconcile()
    expect(await processor.validate(cacheDir, newHash)).toBe(true)
  })

  it('uses the placeholder URL when no valid embedded image exists', async () => {
    addTrack('Album/01.flac', 'Album', 'Artist')
    const service = new ArtworkCacheService({
      store,
      cacheDir,
      processor: new FakeProcessor(),
      readArtwork: async () => []
    })

    await service.reconcile(undefined, true)

    expect(albumHash('Album')).toBeNull()
    expect(store.listAlbums({ offset: 0, limit: 10 }).albums[0].artwork).toEqual({
      small: 'fermata://artwork/missing/small',
      large: 'fermata://artwork/missing/large'
    })
  })

  it('falls back to deterministically ranked case-insensitive folder artwork', async () => {
    const track = addTrack('Album/01.flac', 'Album', 'Artist')
    writeFileSync(join(dirname(track), 'Folder.PNG'), 'folder-cover')
    writeFileSync(join(dirname(track), 'cover.jpg'), 'preferred-cover')
    const service = new ArtworkCacheService({
      store,
      cacheDir,
      processor: new FakeProcessor(),
      readArtwork: async () => []
    })

    await service.reconcile(undefined, true)

    expect(albumHash('Album')).toBe(hash('preferred-cover'))
  })

  it('finds an album-level sidecar above sibling disc directories', async () => {
    addTrack('Album/CD1/01.flac', 'Album', 'Artist')
    addTrack('Album/CD2/02.flac', 'Album', 'Artist')
    writeFileSync(join(dir, 'music', 'Album', 'folder.jpg'), 'disc-set-cover')
    const service = new ArtworkCacheService({
      store,
      cacheDir,
      processor: new FakeProcessor(),
      readArtwork: async () => []
    })

    await service.reconcile(undefined, true)

    expect(albumHash('Album')).toBe(hash('disc-set-cover'))
  })

  it('prefers embedded artwork anywhere in the album over a sidecar', async () => {
    const first = addTrack('Album/01.flac', 'Album', 'Artist')
    const second = addTrack('Album/02.flac', 'Album', 'Artist')
    writeFileSync(join(dirname(first), 'cover.jpg'), 'sidecar')
    const service = new ArtworkCacheService({
      store,
      cacheDir,
      processor: new FakeProcessor(),
      readArtwork: reader(new Map([[second, [picture('embedded')]]]))
    })

    await service.reconcile(undefined, true)

    expect(albumHash('Album')).toBe(hash('embedded'))
  })
})
