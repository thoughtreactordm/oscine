import { describe, expect, it } from 'vitest'
import { audioDurationSec, type CdToc, type DiscMetadataProposal } from '@shared/cdrip'
import {
  applyProposal,
  canRip,
  destinationReason,
  discDetection,
  discSummary,
  includeState,
  needsReleasePick,
  pathPreview,
  unmatchedNote,
  type DiscDetection,
  type RipDraftTrack
} from '../../../../src/renderer/panels/tools/cdRipModel'

function toc(audio: number, data = 0): CdToc {
  const entries = []
  let sector = 0
  for (let n = 1; n <= audio; n++) {
    entries.push({
      number: n,
      startSector: sector,
      sectorCount: 150,
      isAudio: true,
      preEmphasis: false
    })
    sector += 150
  }
  for (let n = 1; n <= data; n++) {
    entries.push({
      number: audio + n,
      startSector: sector,
      sectorCount: 300,
      isAudio: false,
      preEmphasis: false
    })
    sector += 300
  }
  return { entries, leadOutSector: sector, firstTrack: 1, lastTrack: audio + data }
}

function proposal(
  source: DiscMetadataProposal['source'],
  extra: Partial<DiscMetadataProposal> = {}
): DiscMetadataProposal {
  return {
    source,
    albumArtist: extra.albumArtist ?? '',
    album: extra.album ?? '',
    year: extra.year ?? null,
    tracks: extra.tracks ?? [],
    ...extra
  }
}

describe('discDetection', () => {
  const states: Record<DiscDetection, ReturnType<typeof discDetection>> = {
    'no-drive': discDetection({ drives: [], toc: null, noDisc: false }),
    'no-disc': discDetection({
      drives: [{ id: 'sr0', label: 'sr0', vendor: '', product: '' }],
      toc: null,
      noDisc: true
    }),
    'not-audio': discDetection({
      drives: [{ id: 'sr0', label: 'sr0', vendor: '', product: '' }],
      toc: toc(0, 1),
      noDisc: false
    }),
    reading: discDetection({
      drives: [{ id: 'sr0', label: 'sr0', vendor: '', product: '' }],
      toc: null,
      noDisc: false
    }),
    ready: discDetection({
      drives: [{ id: 'sr0', label: 'sr0', vendor: '', product: '' }],
      toc: toc(2),
      noDisc: false
    })
  }

  it('renders a distinct state for each detection affordance', () => {
    expect(new Set(Object.values(states)).size).toBe(5)
    expect(states['no-drive']).toBe('no-drive')
    expect(states['no-disc']).toBe('no-disc')
    expect(states['not-audio']).toBe('not-audio')
    expect(states.reading).toBe('reading')
    expect(states.ready).toBe('ready')
  })

  it('treats an empty tray as no-disc even when a TOC was previously held', () => {
    expect(
      discDetection({
        drives: [{ id: 'sr0', label: 'sr0', vendor: '', product: '' }],
        toc: toc(8),
        noDisc: true
      })
    ).toBe('no-disc')
  })
})

describe('discSummary', () => {
  it('counts audio tracks and duration, ignoring a trailing data session', () => {
    const summary = discSummary(toc(2, 1))
    expect(summary.trackCount).toBe(2)
    expect(summary.durationSec).toBe(audioDurationSec(toc(2, 1)))
    expect(summary.durationSec).toBeCloseTo(4, 5)
  })
})

describe('release picker', () => {
  it('skips the picker when consent is off and lands on placeholders', () => {
    const candidates = [proposal('manual')]
    expect(needsReleasePick(candidates)).toBe(false)
    expect(unmatchedNote({ lookupsAllowed: false, candidates, pickerSettled: true })).toMatch(
      /online lookups are off/i
    )
  })

  it('requires an explicit choice when there are MusicBrainz hits; none is pre-selected', () => {
    const candidates = [
      proposal('musicbrainz', { album: 'A', releaseMbid: '11111111-1111-4111-8111-111111111111' }),
      proposal('musicbrainz', { album: 'B', releaseMbid: '22222222-2222-4222-8222-222222222222' })
    ]
    expect(needsReleasePick(candidates)).toBe(true)
    expect(needsReleasePick([candidates[0]!])).toBe(true)
    expect(unmatchedNote({ lookupsAllowed: true, candidates, pickerSettled: false })).toBeNull()
  })

  it('says an unmatched disc is a normal outcome, not an error', () => {
    expect(
      unmatchedNote({
        lookupsAllowed: true,
        candidates: [proposal('manual')],
        pickerSettled: true
      })
    ).toMatch(/no matching release/i)
  })
})

describe('pathPreview', () => {
  const tracks: RipDraftTrack[] = [
    { number: 1, title: 'One', artist: 'A', included: true },
    { number: 2, title: 'Two', artist: 'B', included: true }
  ]

  it('updates with the template and sanitizes a slash in the album field', () => {
    const slash = pathPreview({
      template: '{albumartist}/{album}/{track:02} {title}',
      album: 'AC/DC',
      albumArtist: 'AC/DC',
      year: 1980,
      tracks
    })
    expect(slash).toBe('AC_DC/AC_DC/01 One.flac')
    expect(slash).not.toContain('AC/DC')

    const renamed = pathPreview({
      template: '{track:02} {title}',
      album: 'AC/DC',
      albumArtist: 'AC/DC',
      year: 1980,
      tracks
    })
    expect(renamed).toBe('01 One.flac')
  })
})

describe('destination and Rip', () => {
  it('disables Rip while the destination is invalid, with the reason shown', () => {
    expect(destinationReason('', null)).toMatch(/choose a destination/i)
    expect(destinationReason('/music', { ok: false, reason: 'outside-roots' })).toMatch(
      /not inside a library folder/i
    )
    expect(canRip({ detection: 'ready', ripping: false, included: 1, destinationOk: false })).toBe(
      false
    )
    expect(canRip({ detection: 'ready', ripping: false, included: 1, destinationOk: true })).toBe(
      true
    )
  })

  it('treats include-header all / some / none as a tri-state', () => {
    expect(includeState(12, 12)).toBe('all')
    expect(includeState(12, 3)).toBe('some')
    expect(includeState(12, 0)).toBe('none')
  })
})

describe('applyProposal', () => {
  it('copies titles without changing include flags', () => {
    const rows: RipDraftTrack[] = [
      { number: 1, title: '', artist: '', included: false },
      { number: 2, title: '', artist: '', included: true }
    ]
    const next = applyProposal(
      rows,
      proposal('musicbrainz', {
        tracks: [
          { number: 1, title: 'One', artist: 'A' },
          { number: 2, title: 'Two', artist: 'B' }
        ]
      })
    )
    expect(next[0]).toMatchObject({ title: 'One', included: false })
    expect(next[1]).toMatchObject({ title: 'Two', included: true })
  })
})
