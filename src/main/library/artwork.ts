import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { readEmbeddedArtwork, type EmbeddedArtwork, type EmbeddedArtworkReader } from './metadata'
import { WorkerArtworkImageProcessor, type ArtworkImageProcessor } from './artworkProcessor'
import { artworkHash, createDerivedArtworkStore, type StoredArtwork } from './derivedArtwork'
import type { ArtworkOriginalsStore } from './artworkOriginals'
import type { ArtworkAlbum, ArtworkOverrideTarget, LibraryStore } from './store'
import { OscineError } from '@shared/errors'
import { MAX_ARTWORK_INGEST_BYTES, sniffImageMime, type ArtworkRef } from '@shared/artwork'

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
  /** W16-9: artwork overrides retired because the file caught up to them. */
  artworkOverridesRetired: number
  /** W16-9: originals dropped by the refcount GC after this reconcile. */
  originalsPruned: number
  elapsedMs: number
  concurrency: number
}

export interface ArtworkCacheDeps {
  store: LibraryStore
  cacheDir: string
  readArtwork?: EmbeddedArtworkReader
  processor?: ArtworkImageProcessor
  /**
   * W16-9's override-originals store. When present, `reconcile` also retires
   * artwork overrides the file has caught up to and GCs the originals no live
   * override references. Absent (e.g. a library with no user-data dir wired) and
   * the pass is skipped — text reconciliation is unaffected.
   */
  originals?: ArtworkOriginalsStore
  now?: () => number
  /**
   * Hashes referenced by something outside `library.db`.
   *
   * W7-13's artist photographs live in the same directory as album art but are
   * referenced from a `cache.db` row, because they are derived external
   * metadata that D14 says must be deletable without loss. Prune has to be able
   * to see them or the next reconcile deletes every one — and, read the other
   * way, an operator who clears the metadata cache gets the disk back without
   * anything else needing to be told.
   *
   * A thunk rather than a set, because prune runs long after construction and
   * the answer changes underneath it.
   */
  externalReferences?: () => Iterable<string>
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
  private readonly derived: ReturnType<typeof createDerivedArtworkStore>
  private readonly originals: ArtworkOriginalsStore | null
  private readonly now: () => number
  private readonly externalReferences: () => Iterable<string>

  constructor(deps: ArtworkCacheDeps) {
    this.store = deps.store
    this.cacheDir = deps.cacheDir
    this.readArtwork = deps.readArtwork ?? readEmbeddedArtwork
    this.processor = deps.processor ?? new WorkerArtworkImageProcessor()
    this.derived = createDerivedArtworkStore({ cacheDir: this.cacheDir, processor: this.processor })
    this.originals = deps.originals ?? null
    this.now = deps.now ?? Date.now
    this.externalReferences = deps.externalReferences ?? (() => [])
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

    // W16-9: settle artwork overrides against the files as they are now, before
    // pruning. A file that has caught up to its chosen cover (a flush, or another
    // tool writing the same image) retires the override; a released hash then
    // drops from the originals store on the GC below.
    const { retired: artworkOverridesRetired, pruned: originalsPruned } =
      await this.reconcileArtworkOverrides()

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
      artworkOverridesRetired,
      originalsPruned,
      elapsedMs: this.now() - started,
      concurrency: RECONCILE_CONCURRENCY
    }
    console.info(`[artwork] ${JSON.stringify(metrics)}`)
    return metrics
  }

  async close(): Promise<void> {
    await this.processor.close()
  }

  /**
   * Ingests operator-supplied cover bytes as a `set` override — **W16-10**,
   * design authority Decision A/B/C.
   *
   * The one door image bytes take into the correction layer, shared by the
   * file-dialog and drag/drop/paste paths. It refuses an oversize, non-JPEG/PNG
   * or undecodable file before storing anything, keeps the full-resolution
   * original the flush will one day write back, derives the display thumbnail so
   * the cover shows everywhere before any flush, and fans the `set` row out
   * across every track (Decision C — storage stays per-track). The returned
   * {@link ArtworkRef} carries no bytes; the renderer addresses the thumbnail by
   * its `hash`.
   */
  async setCover(trackIds: readonly number[], bytes: Uint8Array): Promise<ArtworkRef> {
    if (!this.originals) {
      throw new OscineError('internal', 'Artwork overrides are unavailable on this library.')
    }
    if (bytes.byteLength === 0) {
      throw new OscineError('invalid-request', 'That image file is empty.')
    }
    if (bytes.byteLength > MAX_ARTWORK_INGEST_BYTES) {
      throw new OscineError(
        'invalid-request',
        'That image is too large. Choose a cover under 32 MB.'
      )
    }
    const mime = sniffImageMime(bytes)
    if (!mime) {
      throw new OscineError('invalid-request', 'That file is not a JPEG or PNG image.')
    }
    // `derived.store` decodes with sharp and writes both thumbnail variants, so
    // it doubles as the decodability gate and is what makes the cover visible
    // before any flush. `null` is sharp refusing the bytes — a corrupt file
    // wearing a valid magic number — and nothing has been stored yet.
    const stored = await this.derived.store(bytes, 'operator-supplied cover')
    if (!stored) {
      throw new OscineError('invalid-request', 'That image could not be read.')
    }
    // The originals store keys on the same SHA-256 the thumbnail did, so the
    // full-res bytes, their thumbnail and every override row agree on one hash.
    const hash = await this.originals.put(bytes)
    this.store.setArtworkOverrides(trackIds, hash, mime, this.now())
    return { present: true, hash, mime }
  }

  /**
   * Sets the tri-state *clear* on a batch — **W16-10**. Each track gains a
   * NULL-hash override: no cover now, and the flush strips the front cover. A
   * hash the clear leaves unreferenced is GC'd from the originals store at once
   * (R8) rather than waiting for the next reconcile.
   */
  async clearCover(trackIds: readonly number[]): Promise<void> {
    this.store.clearArtworkOverrides(trackIds, this.now())
    await this.gcOriginals()
  }

  /**
   * Drops the override on a batch — **W16-10**, back to the file's own cover
   * (*absent*). Releases any originals the removed rows were the last to name.
   */
  async revertCover(trackIds: readonly number[]): Promise<void> {
    this.store.removeArtworkOverrides(trackIds)
    await this.gcOriginals()
  }

  /** Releases originals no live override still names — the refcount GC (R8). */
  private async gcOriginals(): Promise<void> {
    if (!this.originals) return
    await this.originals.gc(this.store.listReferencedOverrideImageHashes())
  }

  private async selectArtwork(
    album: ArtworkAlbum,
    noteRead: () => void
  ): Promise<StoredArtwork | null> {
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
        const selected = await this.derived.store(
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
      const selected = await this.derived.store(bytes, `sidecar ${path}`)
      if (selected) return selected
    }
    return null
  }

  /**
   * Re-scan reconciliation for artwork overrides — **W16-9**, design authority
   * D28, extending W16-7's retire-on-match pass to the cover layer it never knew
   * about.
   *
   * Text reconciliation rides the scan's write transaction off the tags already
   * in hand (`LibraryStore.reconcileOverride`), but the scan reads no covers on
   * purpose (`skipCovers` — a large library's embedded art will not fit in RAM).
   * So artwork settles here, where covers are already being read, and only for
   * the few tracks that carry an override: each one's file front cover is read
   * fresh (R7), and the override retired the moment the file holds what it asked
   * for — a chosen image the file now carries, or a clear whose front cover is
   * gone. The originals GC then releases every hash no surviving override names
   * (R8), so a set-cover → flush → wipe → re-scan round trip ends with both
   * `artwork_overrides` and the originals store empty.
   */
  private async reconcileArtworkOverrides(): Promise<{ retired: number; pruned: number }> {
    if (!this.originals) return { retired: 0, pruned: 0 }

    let retired = 0
    for (const target of this.store.listArtworkOverrideTargets()) {
      let pictures: EmbeddedArtwork[]
      try {
        pictures = await this.readArtwork(target.absPath)
      } catch (error) {
        // A file that cannot be read now offers no fresh read to reconcile
        // against; leave the override pending, as an incremental scan would.
        console.warn(
          `[artwork] override reconcile skipped track ${target.trackId}: ${describe(error)}`
        )
        continue
      }
      if (overrideSatisfied(target, pictures)) {
        this.store.removeArtworkOverride(target.trackId)
        retired++
      }
      await yieldToEventLoop()
    }

    const pruned = await this.originals.gc(this.store.listReferencedOverrideImageHashes())
    return { retired, pruned }
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

  /**
   * Deletes every file no live reference names.
   *
   * There is no byte budget and no least-recently-used ordering here, which is
   * what makes W7-13's "does not preferentially evict album art" true by
   * construction rather than by a weighting somebody has to keep correct.
   * Nothing competes: album art lives exactly as long as an album with tracks
   * references it, a podcast cover as long as its show, and an artist
   * photograph as long as the `cache.db` row that names it — three independent
   * lifetimes, none of which can shorten another's.
   */
  private async prune(): Promise<number> {
    const referenced = this.store.listReferencedArtworkHashes()
    for (const hash of this.externalReferences()) referenced.add(hash)
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

/**
 * The file's front-cover picture, or `null` — the frame Decision B writes and
 * clears. A typed front cover wins; failing that, a file carrying exactly one
 * *untyped* picture treats it as the de-facto front (the common single-cover
 * case, and what a flush would have replaced). A lone picture that is explicitly
 * typed something else — a back cover, a disc label — is not a front cover, so a
 * file left with only that reads as having no front cover to match.
 */
function resolveFrontCover(pictures: readonly EmbeddedArtwork[]): EmbeddedArtwork | null {
  const typed = pictures.find((picture) => (picture.type ?? '').toLowerCase().includes('front'))
  if (typed) return typed
  return pictures.length === 1 && (pictures[0].type ?? '') === '' ? pictures[0] : null
}

/**
 * Whether the file has caught up to a track's artwork override — the retire test.
 *
 * A chosen cover (`imageHash` set) is satisfied once the file's front cover *is*
 * those exact bytes, hashed by the same SHA-256 the originals store keyed them
 * under. A clear (`imageHash` null) is satisfied once the file has no front cover
 * left. Symmetric with Decision B, which writes and strips only that one frame.
 */
function overrideSatisfied(
  target: ArtworkOverrideTarget,
  pictures: readonly EmbeddedArtwork[]
): boolean {
  const front = resolveFrontCover(pictures)
  if (target.imageHash === null) return front === null
  return front !== null && artworkHash(front.bytes) === target.imageHash
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
