import { createHash } from 'node:crypto'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { readEmbeddedArtwork, type EmbeddedArtworkReader } from './metadata'
import { WorkerArtworkImageProcessor, type ArtworkImageProcessor } from './artworkProcessor'
import type { ArtworkAlbum, LibraryStore } from './store'

const RECONCILE_CONCURRENCY = 2
const CACHE_FILE = /^([a-f0-9]{64})-(small|large)\.webp$/
const SIDECAR_BASENAMES = ['cover', 'folder', 'front', 'albumart', 'albumcover', 'artwork'] as const
const SIDECAR_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.gif',
  '.tif',
  '.tiff'
] as const
const SIDECAR_BASENAME_RANK: ReadonlyMap<string, number> = new Map(
  SIDECAR_BASENAMES.map((name, index) => [name, index])
)
const SIDECAR_EXTENSION_RANK: ReadonlyMap<string, number> = new Map(
  SIDECAR_EXTENSIONS.map((name, index) => [name, index])
)

export interface ArtworkCacheMetrics {
  albumsChecked: number
  sourceFilesRead: number
  uniqueHashes: number
  thumbnailsGenerated: number
  cacheFiles: number
  cacheBytes: number
  prunedFiles: number
  elapsedMs: number
  concurrency: number
}

export interface ArtworkCacheDeps {
  store: LibraryStore
  cacheDir: string
  readArtwork?: EmbeddedArtworkReader
  processor?: ArtworkImageProcessor
  now?: () => number
}

/**
 * Content-addressed derived-art service.
 *
 * SHA-256 is over the exact embedded or sidecar image bytes. That stable input is
 * deliberate: it deduplicates byte-identical covers without making cache
 * identity depend on sharp/WebP versions. Only two named variants may exist,
 * and every reconciliation removes files no live album references.
 */
export class ArtworkCacheService {
  readonly cacheDir: string
  private readonly store: LibraryStore
  private readonly readArtwork: EmbeddedArtworkReader
  private readonly processor: ArtworkImageProcessor
  private readonly now: () => number
  private readonly generating = new Map<string, Promise<boolean>>()

  constructor(deps: ArtworkCacheDeps) {
    this.store = deps.store
    this.cacheDir = deps.cacheDir
    this.readArtwork = deps.readArtwork ?? readEmbeddedArtwork
    this.processor = deps.processor ?? new WorkerArtworkImageProcessor()
    this.now = deps.now ?? Date.now
  }

  async reconcile(albumIds?: readonly number[], force = false): Promise<ArtworkCacheMetrics> {
    const started = this.now()
    const albums = this.store.listArtworkAlbums(albumIds)
    let sourceFilesRead = 0
    let thumbnailsGenerated = 0
    const hashes = new Set<string>()
    const generatedHashes = new Set<string>()

    await mapPool(albums, RECONCILE_CONCURRENCY, async (album) => {
      if (
        !force &&
        album.artworkHash &&
        (await this.processor.validate(this.cacheDir, album.artworkHash))
      ) {
        hashes.add(album.artworkHash)
        return
      }

      const selected = await this.selectArtwork(album, () => {
        sourceFilesRead++
      })
      if (!selected) {
        this.store.setAlbumArtwork(album.albumId, null)
        return
      }

      hashes.add(selected.hash)
      if (selected.generated && !generatedHashes.has(selected.hash)) {
        generatedHashes.add(selected.hash)
        thumbnailsGenerated++
      }
      this.store.setAlbumArtwork(album.albumId, selected.hash)
    })

    const prunedFiles = await this.prune()
    const { files: cacheFiles, bytes: cacheBytes } = await cacheTotals(this.cacheDir)
    const metrics: ArtworkCacheMetrics = {
      albumsChecked: albums.length,
      sourceFilesRead,
      uniqueHashes: hashes.size,
      thumbnailsGenerated,
      cacheFiles,
      cacheBytes,
      prunedFiles,
      elapsedMs: this.now() - started,
      concurrency: RECONCILE_CONCURRENCY
    }
    console.info(`[artwork] ${JSON.stringify(metrics)}`)
    return metrics
  }

  async close(): Promise<void> {
    await this.processor.close()
  }

  private async selectArtwork(
    album: ArtworkAlbum,
    noteRead: () => void
  ): Promise<{ hash: string; generated: boolean } | null> {
    // Embedded pictures are authoritative. Search every album track before
    // considering a folder image so one untagged first track cannot mask a
    // valid embedded cover on a later track.
    for (const track of album.tracks) {
      let pictures
      try {
        noteRead()
        pictures = await this.readArtwork(track.absPath)
      } catch (error) {
        console.warn(`[artwork] skipped track ${track.trackId}: ${describe(error)}`)
        continue
      }
      for (const picture of pictures) {
        const selected = await this.processCandidate(
          picture.bytes,
          `picture ${picture.index} in track ${track.trackId}`
        )
        if (selected) return selected
      }
      await yieldToEventLoop()
    }

    for (const path of await sidecarCandidates(album.tracks.map((track) => track.absPath))) {
      let bytes: Uint8Array
      try {
        noteRead()
        bytes = await readFile(path)
      } catch (error) {
        console.warn(`[artwork] skipped sidecar ${path}: ${describe(error)}`)
        continue
      }
      const selected = await this.processCandidate(bytes, `sidecar ${path}`)
      if (selected) return selected
    }
    return null
  }

  private async processCandidate(
    bytes: Uint8Array,
    description: string
  ): Promise<{ hash: string; generated: boolean } | null> {
    if (bytes.byteLength === 0) return null
    const hash = createHash('sha256').update(bytes).digest('hex')
    let generation: Promise<boolean> | undefined
    try {
      // `generate` is also validation. It writes nothing final until sharp
      // has decoded the source and produced a complete temporary file.
      generation = this.generating.get(hash)
      if (!generation) {
        generation = this.processor.generate(this.cacheDir, hash, bytes)
        this.generating.set(hash, generation)
      }
      const generated = await generation
      return { hash, generated }
    } catch (error) {
      console.warn(`[artwork] malformed ${description}: ${describe(error)}`)
      return null
    } finally {
      if (generation && this.generating.get(hash) === generation) this.generating.delete(hash)
    }
  }

  /**
   * Drops cache files no album references any more, without re-deriving any.
   *
   * `reconcile()` also prunes, but it prunes *after* walking every album to
   * check its artwork is still valid — which is the right shape when the
   * library has changed underneath us and the wrong one when it has only
   * shrunk. Removing a root deletes albums and creates unreferenced files; it
   * cannot invalidate the artwork of an album that is still there. So this is
   * the second half of `reconcile` on its own.
   */
  async sweep(): Promise<number> {
    return this.prune()
  }

  private async prune(): Promise<number> {
    const referenced = this.store.listReferencedArtworkHashes()
    let entries
    try {
      entries = await readdir(this.cacheDir, { withFileTypes: true })
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return 0
      throw error
    }

    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = CACHE_FILE.exec(entry.name)
      if (match && referenced.has(match[1])) continue
      await rm(join(this.cacheDir, entry.name), { force: true })
      removed++
    }
    return removed
  }
}

/**
 * Whether a watcher path can affect automatic folder-art selection.
 *
 * Matching is case-insensitive because Windows libraries routinely contain
 * `Folder.JPG`, and the same library should behave identically on Linux.
 */
export function isArtworkSidecarPath(path: string): boolean {
  const extension = extname(path).toLowerCase()
  if (!SIDECAR_EXTENSION_RANK.has(extension)) return false
  const stem = path.slice(0, -extension.length).split(/[\\/]/).pop()?.toLowerCase()
  return stem !== undefined && SIDECAR_BASENAME_RANK.has(stem)
}

async function sidecarCandidates(trackPaths: readonly string[]): Promise<string[]> {
  const trackDirectories = [...new Set(trackPaths.map(dirname))]
  const directories = [...trackDirectories]

  // A multi-disc album is commonly Album/CD1 + Album/CD2 with one cover in
  // Album. Only climb when every track directory is a distinct direct child of
  // the same parent; this avoids accidentally taking an artist-folder image.
  if (trackDirectories.length > 1) {
    const parent = dirname(trackDirectories[0])
    if (trackDirectories.every((directory) => dirname(directory) === parent)) {
      directories.unshift(parent)
    }
  }

  const candidates: string[] = []
  for (const directory of directories) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        console.warn(`[artwork] skipped sidecar directory ${directory}: ${describe(error)}`)
      }
      continue
    }
    const names = entries
      .filter((entry) => entry.isFile() && isArtworkSidecarPath(entry.name))
      .map((entry) => entry.name)
      .sort(compareSidecars)
    candidates.push(...names.map((name) => join(directory, name)))
  }
  return candidates
}

function compareSidecars(left: string, right: string): number {
  const leftExtension = extname(left).toLowerCase()
  const rightExtension = extname(right).toLowerCase()
  const leftStem = left.slice(0, -leftExtension.length).toLowerCase()
  const rightStem = right.slice(0, -rightExtension.length).toLowerCase()
  return (
    SIDECAR_BASENAME_RANK.get(leftStem)! - SIDECAR_BASENAME_RANK.get(rightStem)! ||
    SIDECAR_EXTENSION_RANK.get(leftExtension)! - SIDECAR_EXTENSION_RANK.get(rightExtension)! ||
    left.localeCompare(right, 'en')
  )
}

async function mapPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

async function cacheTotals(cacheDir: string): Promise<{ files: number; bytes: number }> {
  let entries
  try {
    entries = await readdir(cacheDir, { withFileTypes: true })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { files: 0, bytes: 0 }
    throw error
  }
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile() || !CACHE_FILE.test(entry.name)) continue
    files++
    bytes += (await stat(join(cacheDir, entry.name))).size
  }
  return { files, bytes }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
