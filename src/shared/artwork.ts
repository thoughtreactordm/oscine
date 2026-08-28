/**
 * The cover-art vocabulary shared across the main/renderer seam — **W16-10**.
 *
 * Free of any Node or Electron import, like every `src/shared` module: the
 * renderer imports it, and the renderer has no filesystem. Image *bytes* never
 * appear here — a batch is thousands of tracks, so a cover crosses the wire as a
 * reference the renderer re-addresses through the `oscine://` thumbnail route.
 */

/**
 * A track's cover as it stands in the correction layer, with no bytes attached.
 *
 * The renderer builds the thumbnail URL from `hash` via `artworkUrl`; it never
 * learns where the original lives on disk. `present: false` is the tri-state
 * *clear* — a cover deliberately removed — as distinct from *absent* (no
 * override at all), which this type does not describe because it is the file's
 * own cover and needs no reference.
 */
export interface ArtworkRef {
  /** True when a cover is set; false is the tri-state clear (removed on flush). */
  present: boolean
  /** SHA-256 the originals store keyed the bytes under, or null when cleared. */
  hash: string | null
  /** The image's media type, or null when cleared. */
  mime: string | null
}

/**
 * The media types Oscine ingests and later writes back as a front cover
 * (Decision B). JPEG and PNG are the two a tagger reliably round-trips; the
 * ingest refuses everything else before sharp ever decodes it.
 */
export const INGESTIBLE_IMAGE_MIMES = ['image/jpeg', 'image/png'] as const
export type IngestibleImageMime = (typeof INGESTIBLE_IMAGE_MIMES)[number]

/**
 * The largest cover file the ingest accepts. Full-resolution album art is
 * routinely a few megabytes; this ceiling turns a pathological file away at the
 * seam without getting in a poweruser's way.
 */
export const MAX_ARTWORK_INGEST_BYTES = 32 * 1024 * 1024

/**
 * Sniffs a supported image's media type from its leading bytes, or `null` for
 * anything that is not a JPEG or PNG.
 *
 * Deliberately a container check rather than a full parse: sharp decodes the
 * bytes downstream and is the real validity gate, so this only has to reject the
 * wrong *format* — and it does so from the bytes themselves, because the MIME a
 * renderer declares for a dropped blob is not trusted.
 */
export function sniffImageMime(bytes: Uint8Array): IngestibleImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  return null
}
