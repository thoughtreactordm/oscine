import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artworkHash } from './derivedArtwork'

/**
 * The override-originals store — **W16-9**, design authority
 * `oscine-tag-writeback` → "Embedded artwork & custom frames" (Decision A).
 *
 * A content-addressed directory of *full-resolution* cover bytes: the covers the
 * operator chose and has not yet flushed into their files. It is the artwork
 * counterpart to the thumbnail cache (`derivedArtwork.ts`) but holds the opposite
 * kind of thing — the thumbnails are re-derivable display art keyed by hash, and
 * these are the authoritative source bytes a flush will write back, keyed by the
 * *same* SHA-256 so a set cover, its thumbnail and the future file write all agree
 * on one hash. Thumbnails will not do: the flush must reproduce the operator's
 * image, not a downscaled WebP of it.
 *
 * What it deliberately does not know is who references a hash. That is
 * `artwork_overrides.image_hash` in `library.db`, so {@link ArtworkOriginalsStore.gc}
 * takes the live set of referenced hashes from the store and drops every file no
 * override row names — a refcount over the column, exactly as
 * `ArtworkCacheService.prune` keeps reference-keeping with the owner (R8: without
 * it the originals grow unbounded as overrides retire).
 *
 * Electron-free like the rest of `db/`-adjacent storage: it takes a directory
 * path, so a plain-Node test drives it against a temp dir.
 */

/** A hash-named original file. No extension: the media type lives in the DB row. */
const ORIGINAL_FILE = /^[a-f0-9]{64}$/

export interface ArtworkOriginalsStore {
  /**
   * Writes the exact source bytes and returns their SHA-256 hash. Idempotent:
   * byte-identical covers dedupe to one file, so a shared album cover set across
   * twenty tracks is stored once and refcounted twenty times.
   */
  put(bytes: Uint8Array): Promise<string>
  /** The stored full-resolution bytes for a hash, or `null` if absent. */
  read(hash: string): Promise<Uint8Array | null>
  /** Whether a hash is present and readable. */
  has(hash: string): Promise<boolean>
  /**
   * Deletes every stored original no live override references. Returns the count
   * removed. `referenced` is the set of `artwork_overrides.image_hash` values,
   * read fresh by the caller so it reflects the retirements this reconcile made.
   */
  gc(referenced: ReadonlySet<string>): Promise<number>
}

export interface ArtworkOriginalsStoreOptions {
  dir: string
}

export function createArtworkOriginalsStore({
  dir
}: ArtworkOriginalsStoreOptions): ArtworkOriginalsStore {
  const pathFor = (hash: string): string => join(dir, hash)

  return {
    async put(bytes): Promise<string> {
      const hash = artworkHash(bytes)
      await mkdir(dir, { recursive: true })
      const final = pathFor(hash)
      // Write to a per-hash temp name then rename, so a crash mid-write never
      // leaves a truncated file under a hash that claims to be complete. The
      // temp name is derived from the hash rather than a clock/random so it is
      // deterministic and two writers of the same bytes cannot collide on it.
      const temp = `${final}.tmp`
      await writeFile(temp, bytes)
      await rename(temp, final)
      return hash
    },

    async read(hash): Promise<Uint8Array | null> {
      if (!ORIGINAL_FILE.test(hash)) return null
      try {
        return await readFile(pathFor(hash))
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null
        throw error
      }
    },

    async has(hash): Promise<boolean> {
      return (await this.read(hash)) !== null
    },

    async gc(referenced): Promise<number> {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return 0
        throw error
      }
      let removed = 0
      for (const entry of entries) {
        if (!entry.isFile()) continue
        // A leftover `.tmp` from an interrupted put matches no hash and is
        // referenced by nothing, so it is swept here too.
        if (ORIGINAL_FILE.test(entry.name) && referenced.has(entry.name)) continue
        await rm(join(dir, entry.name), { force: true })
        removed++
      }
      return removed
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
