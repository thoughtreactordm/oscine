import {
  audioDurationSec,
  audioTocEntries,
  type CdDriveInfo,
  type CdToc,
  type DiscMetadataProposal,
  type RipCollision,
  type RipDestinationFailure,
  type RipDestinationResult,
  type RipOutcomeStatus,
  type RipPhase,
  type RipResumeOffer
} from '@shared/cdrip'
import { renderRipPath } from '@shared/ripPath'
import type { CheckState } from './tagWritebackModel'

/**
 * The Tools pane's pure half — **W18-7**. Detection, picker visibility, the
 * live path preview, and whether Rip may fire. Kept out of the store so a Node
 * Vitest can drive every state without Pinia, IPC or a DOM.
 */

export type DiscDetection = 'no-drive' | 'no-disc' | 'not-audio' | 'reading' | 'ready'

export interface DiscDetectionInput {
  drives: readonly CdDriveInfo[]
  toc: CdToc | null
  /** `not-found` from `readToc` is an empty tray, not a missing drive. */
  noDisc: boolean
}

export function discDetection(input: DiscDetectionInput): DiscDetection {
  if (input.drives.length === 0) return 'no-drive'
  if (input.noDisc) return 'no-disc'
  if (input.toc === null) return 'reading'
  if (audioTocEntries(input.toc).length === 0) return 'not-audio'
  return 'ready'
}

export interface DiscSummary {
  trackCount: number
  durationSec: number
}

export function discSummary(toc: CdToc): DiscSummary {
  return {
    trackCount: audioTocEntries(toc).length,
    durationSec: audioDurationSec(toc)
  }
}

/**
 * MusicBrainz hits need an explicit choice — even one of them. CD-TEXT and
 * empty manual fields skip the picker and land on the table.
 */
export function needsReleasePick(candidates: readonly DiscMetadataProposal[]): boolean {
  return candidates.some((candidate) => candidate.source === 'musicbrainz')
}

export function unmatchedNote(input: {
  lookupsAllowed: boolean
  candidates: readonly DiscMetadataProposal[]
  /** The operator confirmed a MusicBrainz hit, or skipped the picker. */
  pickerSettled: boolean
}): string | null {
  if (needsReleasePick(input.candidates) && !input.pickerSettled) return null
  const source = input.candidates[0]?.source
  if (source === 'musicbrainz') return null
  if (!input.lookupsAllowed) {
    return 'Online lookups are off. Titles are placeholders until you fill them in.'
  }
  if (source === 'cdtext') return 'No MusicBrainz match. Titles are from CD-TEXT.'
  return 'No matching release found. Titles are placeholders until you fill them in.'
}

export interface RipDraftTrack {
  number: number
  title: string
  artist: string
  included: boolean
}

export function pathPreview(input: {
  template: string
  album: string
  albumArtist: string
  year: number | null
  tracks: readonly RipDraftTrack[]
}): string | null {
  const first = input.tracks.find((track) => track.included)
  if (!first) return null
  const rel = renderRipPath(input.template, {
    albumartist: input.albumArtist,
    artist: first.artist.trim() === '' ? input.albumArtist : first.artist,
    album: input.album,
    title: first.title,
    track: first.number,
    disc: 1,
    discCount: 1,
    year: input.year
  })
  return `${rel}.flac`
}

export function destinationReason(
  dest: string,
  result: RipDestinationResult | null
): string | null {
  if (dest.trim() === '') return 'Choose a destination folder inside a library folder.'
  if (result === null) return null
  if (result.ok) return null
  return DESTINATION_FAILURE[result.reason]
}

const DESTINATION_FAILURE: Record<RipDestinationFailure, string> = {
  'outside-roots': 'That folder is not inside a library folder.',
  'cross-device':
    'That folder is on a different drive from the library folder. Rips have to land on the same volume so files can be renamed into place.',
  'not-writable': 'That folder cannot be written to.'
}

export function canRip(input: {
  detection: DiscDetection
  ripping: boolean
  included: number
  destinationOk: boolean
}): boolean {
  return input.detection === 'ready' && !input.ripping && input.included > 0 && input.destinationOk
}

export function resumeOfferText(offer: RipResumeOffer): string {
  const album = offer.album.trim() === '' ? 'this disc' : offer.album
  return `Resume ripping ${album} — ${offer.remaining} of ${offer.total} tracks remaining.`
}

export function canOfferResume(input: {
  offer: RipResumeOffer | null
  discId: string | null
  ripping: boolean
}): boolean {
  return (
    input.offer !== null &&
    input.discId !== null &&
    input.offer.discId === input.discId &&
    !input.ripping
  )
}

export function includeState(total: number, included: number): CheckState {
  if (total <= 0 || included <= 0) return 'none'
  if (included >= total) return 'all'
  return 'some'
}

export function applyProposal(
  tracks: readonly RipDraftTrack[],
  proposal: DiscMetadataProposal
): RipDraftTrack[] {
  return tracks.map((track) => {
    const match = proposal.tracks.find((row) => row.number === track.number)
    if (!match) return track
    return { ...track, title: match.title, artist: match.artist }
  })
}

export const RIP_PHASE_LABEL: Record<RipPhase, string> = {
  reading: 'Reading',
  encoding: 'Encoding',
  tagging: 'Tagging',
  verifying: 'Verifying'
}

export const RIP_COLLISION_OPTIONS: readonly { value: RipCollision; label: string }[] = [
  { value: 'suffix', label: 'Add a suffix' },
  { value: 'skip', label: 'Skip existing' },
  { value: 'overwrite', label: 'Overwrite' }
]

export function outcomeMeta(status: RipOutcomeStatus): {
  icon: string
  text: string
  cls: string
} {
  switch (status) {
    case 'written':
      return { icon: 'i-tabler-check', text: 'Written', cls: 'text-success' }
    case 'skipped':
      return { icon: 'i-tabler-minus', text: 'Skipped', cls: 'text-dimmed' }
    case 'verify-failed':
      return { icon: 'i-tabler-alert-triangle', text: 'Verify failed', cls: 'text-warning' }
    case 'failed':
      return { icon: 'i-tabler-alert-triangle', text: 'Failed', cls: 'text-error' }
  }
}

export const POLL_MS = 2_000
