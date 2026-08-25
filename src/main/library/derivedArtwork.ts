/**
 * The content-addressed thumbnail cache, as anything that has bytes sees it.
 *
 * This was inside `ArtworkCacheService` until W7-13 needed a second producer.
 * The card's note is explicit about why it moved rather than being copied: two
 * caches with two eviction policies competing for the same disk budget is the
 * failure mode, and the way to not have two policies is to not have two caches.
 * An artist photograph from Wikimedia Commons is hashed by the same function,
 * written to the same directory under the same filename scheme, served by the
 * same `oscine://artwork/<hash>/<variant>` route, and swept by the same prune.
 *
 * What it deliberately does *not* know is who references a hash. Album art is
 * referenced from `albums.artwork_hash`, a podcast cover from
 * `podcasts.artwork_hash`, and an artist photograph from a row in `cache.db` —
 * three different owners with three different lifetimes, all reaching one
 * store. Reference-keeping stays with the owner; see `ArtworkCacheService.prune`.
 */

import { createHash } from 'node:crypto'
import type { ArtworkImageProcessor } from './artworkProcessor'

export interface StoredArtwork {
  hash: string
  /** False when both variants were already on disk. Counted, not acted on. */
  generated: boolean
}

export interface DerivedArtworkStore {
  /**
   * Derives both variants from source bytes and returns their shared hash.
   *
   * `null` means the bytes were not an image the processor could read — a
   * fact worth a log line and never worth an exception, because every caller
   * here is holding something a stranger produced: an embedded picture frame
   * written by an unknown tagger, a folder image, a file from Commons.
   */
  store(bytes: Uint8Array, description: string): Promise<StoredArtwork | null>
  /** Whether both variants for a hash are present and readable. */
  has(hash: string): Promise<boolean>
}

export interface DerivedArtworkStoreOptions {
  cacheDir: string
  processor: ArtworkImageProcessor
}

/**
 * SHA-256 over the exact source bytes.
 *
 * The stable input is deliberate: it deduplicates byte-identical covers without
 * making cache identity depend on sharp's or WebP's version. Re-encoding the
 * same picture with a newer sharp must not orphan every file in the directory.
 */
export function artworkHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function createDerivedArtworkStore({
  cacheDir,
  processor
}: DerivedArtworkStoreOptions): DerivedArtworkStore {
  /**
   * In-flight generations, keyed by hash.
   *
   * A compilation is one cover repeated across twenty tracks, and a scan walks
   * them concurrently. Without this the same bytes are decoded and encoded
   * twenty times, and twenty writers race over one pair of filenames.
   */
  const generating = new Map<string, Promise<boolean>>()

  return {
    async store(bytes, description): Promise<StoredArtwork | null> {
      if (bytes.byteLength === 0) return null
      const hash = artworkHash(bytes)
      let generation: Promise<boolean> | undefined
      try {
        // `generate` is also validation. It writes nothing final until sharp
        // has decoded the source and produced a complete temporary file.
        generation = generating.get(hash)
        if (!generation) {
          generation = processor.generate(cacheDir, hash, bytes)
          generating.set(hash, generation)
        }
        return { hash, generated: await generation }
      } catch (error) {
        console.warn(
          `[artwork] malformed ${description}: ` +
            (error instanceof Error ? error.message : String(error))
        )
        return null
      } finally {
        if (generation && generating.get(hash) === generation) generating.delete(hash)
      }
    },

    has(hash): Promise<boolean> {
      return processor.validate(cacheDir, hash)
    }
  }
}
