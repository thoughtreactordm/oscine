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
  /** Pixel width, when known. Never required to address the thumbnail. */
  width?: number
  /** Pixel height, when known. Never required to address the thumbnail. */
  height?: number
}

/** No cover — the file has none, or a clear-on-flush override has removed it. */
export const ABSENT_ARTWORK: ArtworkRef = { present: false, hash: null, mime: null }

/** An {@link ArtworkRef} for a hash, or an absent ref when there is none. */
export function artworkRef(hash: string | null, mime: string | null = null): ArtworkRef {
  if (hash === null) return { present: false, hash: null, mime: null }
  return { present: true, hash, mime }
}

/**
 * The media types Oscine ingests and later writes back as a front cover
 * (Decision B). JPEG and PNG are the two a tagger reliably round-trips; the
 * ingest refuses everything else before sharp ever decodes it.
 */
export const INGESTIBLE_IMAGE_MIMES = ['image/jpeg', 'image/png'] as const
export type IngestibleImageMime = (typeof INGESTIBLE_IMAGE_MIMES)[number]

/**
 * A cover the Cover Art Archive offers for a release, as a pair of addresses and
 * no bytes — **W7-15**.
 *
 * The manifest names a full-resolution `image` and a set of `thumbnails`, both
 * on a host that redirects the actual bytes elsewhere; the two URLs are carried
 * unfetched so a caller can show the thumbnail and only pull the full image once
 * the operator picks it. Fetched bytes then take the ordinary
 * `ArtworkCacheService.setCover` door and become an override like any other — a
 * candidate is a reference, never a stored blob, which is why it has no `hash`.
 *
 * CAA does not report pixel dimensions, so `width`/`height` are present only when
 * a source that does (W7-17's iTunes fallback) fills them in.
 */
export interface CoverArtCandidate {
  /**
   * Which service offered it. **W7-17** grew the union to `'itunes'` when the
   * edit-time picker added Apple's catalogue as the fallback for releases
   * MusicBrainz does not have — the promised second member.
   */
  source: 'coverartarchive' | 'itunes'
  /** True when the source marks this the release's front cover. Front candidates sort first. */
  front: boolean
  /** A modestly-sized preview to show in a picker, addressed but not fetched. */
  thumbUrl: string
  /** The full-resolution image, fetched only when the operator picks this candidate. */
  fullUrl: string
  /**
   * A caption for the picker — the release/album title the candidate came from,
   * when the search knew it. The edit-time picker (W7-17) fills this so the
   * operator can tell two editions apart; the rip path leaves it unset.
   */
  title?: string
  /** A second caption line — an artist credit, year or edition disambiguation. */
  detail?: string
  /** Pixel width, when the source reports it. CAA does not; iTunes will. */
  width?: number
  /** Pixel height, when the source reports it. CAA does not; iTunes will. */
  height?: number
}

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
