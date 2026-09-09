export { computeDiscId } from './discId'
export {
  DEFAULT_RIP_NAME_TEMPLATE,
  RIP_DESTINATION_ROOT_KEY,
  RIP_NAME_TEMPLATE_KEY,
  RIP_VERIFY_KEY,
  renderRipPath,
  type RipNameFields
} from './ripPath'

/** Red Book maximum. A request longer than this is a contract bug, not a box set. */
export const MAX_RIP_TRACKS = 99

/**
 * The subset of a library root destination validation needs.
 *
 * Kept here rather than importing `RootRow` so the renderer can type a
 * validation result without pulling the store. The function itself lives in
 * main: it stats the folder, and `src/shared` does not import Node.
 */
export interface RipDestinationRoot {
  id: number
  path: string
}

export type RipDestinationFailure = 'outside-roots' | 'cross-device' | 'not-writable'

export type RipDestinationResult =
  { ok: true; rootId: number; relDir: string } | { ok: false; reason: RipDestinationFailure }

/**
 * Test seam for destination validation. Production leaves it unset
 * and stats the real folder. Cross-device is otherwise untestable in CI: a
 * GitHub runner has one volume.
 */
export interface RipDestinationProbe {
  isDirectory(absPath: string): boolean
  isWritable(absPath: string): boolean
  deviceId(absPath: string): number | bigint | null
}

/** Opaque drive identities: only the native backend interprets id. */
export interface CdDriveInfo {
  id: string
  label: string
  vendor: string
  product: string
}

export interface CdTocEntry {
  number: number
  startSector: number
  sectorCount: number
  isAudio: boolean
  preEmphasis: boolean
}

/** LBA addresses, without the 150-sector MSF bias; includes data tracks. */
export interface CdToc {
  entries: CdTocEntry[]
  leadOutSector: number
  firstTrack: number
  lastTrack: number
  /** Raw format-5 response, including its four-byte header; absent if unavailable. */
  cdText?: Uint8Array
}

export interface ProposedTrack {
  number: number
  title: string
  artist: string
  recordingMbid?: string
}

export interface DiscMetadataProposal {
  source: 'musicbrainz' | 'cdtext' | 'manual'
  releaseMbid?: string
  albumArtist: string
  album: string
  year: number | null
  /** ISO country code from MusicBrainz, so pressings can be told apart. */
  country?: string
  /** Medium format from MusicBrainz (`CD`, `CD-R`, …). */
  format?: string
  tracks: ProposedTrack[]
}

export interface DiscLookupResult {
  discId: string
  candidates: DiscMetadataProposal[]
}

/** Audio tracks only — data sessions stay on the TOC for the disc ID. */
export function audioTocEntries(toc: CdToc): CdTocEntry[] {
  return toc.entries.filter((track) => track.isAudio)
}

/**
 * Red Book: 75 sectors per second. Uses the next track start (or lead-out),
 * not `sectorCount`, so a pregap belongs to the track before it.
 */
export function audioDurationSec(toc: CdToc): number {
  let sectors = 0
  for (let i = 0; i < toc.entries.length; i++) {
    const entry = toc.entries[i]!
    if (!entry.isAudio) continue
    const next = toc.entries[i + 1]?.startSector ?? toc.leadOutSector
    sectors += Math.max(0, next - entry.startSector)
  }
  return sectors / 75
}

export function trackDurationSec(toc: CdToc, number: number): number {
  const index = toc.entries.findIndex((entry) => entry.number === number)
  if (index < 0) return 0
  const entry = toc.entries[index]!
  if (!entry.isAudio) return 0
  const next = toc.entries[index + 1]?.startSector ?? toc.leadOutSector
  return Math.max(0, next - entry.startSector) / 75
}

/** Available immediately, even while a lookup is pending. Data tracks are never ripped. */
export function manualDiscProposal(toc: CdToc): DiscMetadataProposal {
  return {
    source: 'manual',
    albumArtist: '',
    album: '',
    year: null,
    tracks: toc.entries
      .filter((track) => track.isAudio)
      .map((track) => ({
        number: track.number,
        title: '',
        artist: ''
      }))
  }
}

export type CdReadError =
  'no-disc' | 'not-audio' | 'device-busy' | 'read-failed' | 'unsupported-drive'

/** One track the operator confirmed, with the titles they typed or accepted. */
export interface RipTrackSelection {
  number: number
  title: string
  artist: string
}

export type RipCollision = 'skip' | 'overwrite' | 'suffix'

/**
 * A confirmed rip: destination already validated, metadata already chosen.
 *
 * Main re-reads the TOC and never trusts a renderer-supplied sector range.
 */
export interface RipRequest {
  driveId: string
  rootId: number
  relDir: string
  template: string
  tracks: RipTrackSelection[]
  album: string
  albumArtist: string
  year: number | null
  verify: boolean
  onCollision: RipCollision
}

export type RipPhase = 'reading' | 'encoding' | 'tagging' | 'verifying'

export interface RipProgress {
  trackNumber: number
  trackIndex: number
  trackCount: number
  phase: RipPhase
  sectorsDone: number
  sectorsTotal: number
}

/**
 * Why one track did not land cleanly.
 *
 * Encoder `cancelled` is not a per-track code — it becomes `RipReport.cancelled`.
 * Verify mismatch is a status (`verify-failed`), not a code: the file is kept.
 */
export type RipFailureCode =
  CdReadError | 'nonzero-exit' | 'stderr' | 'broken-pipe' | 'tag-failed' | 'destination-failed'

export type RipOutcomeStatus = 'written' | 'skipped' | 'failed' | 'verify-failed'

export interface RipOutcome {
  trackNumber: number
  status: RipOutcomeStatus
  relPath?: string
  code?: RipFailureCode
  /** Set on `verify-failed` so the report names the sector range that disagreed. */
  startSector?: number
  sectorCount?: number
}

export interface RipReport {
  total: number
  written: number
  skipped: number
  failed: number
  cancelled: boolean
  outcomes: RipOutcome[]
  /**
   * Library ids of files that landed (`written` and `verify-failed`), in rip
   * order. Empty when ingest was skipped or failed; the files are still on disk.
   */
  trackIds: number[]
}
