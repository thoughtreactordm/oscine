/**
 * Types for the W16-2 tag-writeback corpus builder, so TypeScript consumers (the
 * W16-3 engine's integration test) can import it. The runtime lives in the
 * sibling `.mjs`; this only describes the exports the test uses.
 */

/** One synthesised fixture track. */
export interface WritebackCorpusTrack {
  readonly id: string
  readonly tagType: string
  readonly file: string
  readonly path: string
}

/** The manifest `buildWritebackCorpus` returns. */
export interface WritebackCorpusManifest {
  readonly version: number
  readonly libraryDir: string
  readonly cover: { readonly bytes: Uint8Array; readonly mimeType: string }
  readonly tracks: readonly WritebackCorpusTrack[]
}

/** The corrected tag values a flush is asked to write over the known-bad baseline. */
export interface CorrectedTags {
  readonly title: string
  readonly artists: readonly string[]
  readonly album: string
  readonly genres: readonly string[]
  readonly year: number
  readonly track: number
  readonly trackCount: number
  readonly disc: number
  readonly discCount: number
}

/** One codec's synthesis spec. */
export interface WritebackCodecSpec {
  readonly id: string
  readonly file: string
  readonly tagType: string
  readonly hz: number
  readonly encode: readonly string[]
}

/** One round-trip verification outcome. */
export interface RoundTripCheck {
  readonly codec: string
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

export const CORPUS_VERSION: number
export const CODECS: readonly WritebackCodecSpec[]
export const CORRECTED: CorrectedTags
export const GENRE_WRITTEN: string

export function buildWritebackCorpus(
  rootDir: string,
  log?: (message: string) => void
): Promise<WritebackCorpusManifest>

export function verifyRoundTrip(
  manifest: WritebackCorpusManifest,
  log?: (message: string) => void
): Promise<{ readonly version: number; readonly checks: readonly RoundTripCheck[] }>
