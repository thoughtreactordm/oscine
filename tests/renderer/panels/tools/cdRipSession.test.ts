import { afterEach, describe, expect, it, vi } from 'vitest'
import { OscineError } from '@shared/errors'
import { computeDiscId } from '@shared/discId'
import type {
  CdDriveInfo,
  CdToc,
  DiscLookupResult,
  DiscMetadataProposal,
  RipDestinationResult,
  RipProgress,
  RipReport,
  RipRequest,
  RipResumeOffer,
  RipResumeRequest
} from '@shared/cdrip'
import {
  createCdRipSession,
  type CdRipBridge,
  type CdRipSessionDeps
} from '../../../../src/renderer/panels/tools/cdRipSession'
import { POLL_MS } from '../../../../src/renderer/panels/tools/cdRipModel'

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

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

const drive: CdDriveInfo = { id: 'sr0', label: 'sr0', vendor: 'Test', product: 'Drive' }

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

function report(partial: Partial<RipReport> = {}): RipReport {
  return {
    total: 1,
    written: 1,
    skipped: 0,
    failed: 0,
    cancelled: false,
    outcomes: [{ trackNumber: 1, status: 'written', relPath: 'a/01 One.flac' }],
    trackIds: [7],
    ...partial
  }
}

function harness(
  overrides: {
    drives?: CdDriveInfo[]
    toc?: CdToc | (() => Promise<CdToc>)
    lookup?: DiscLookupResult | (() => Promise<DiscLookupResult>)
    dest?: RipDestinationResult
    lookupsAllowed?: boolean
    destination?: string
    start?: (request: RipRequest) => Promise<RipReport>
    offer?: RipResumeOffer | null
    resume?: (request: RipResumeRequest) => Promise<RipReport>
  } = {}
) {
  const listDrives = vi.fn(async () => overrides.drives ?? [drive])
  const readToc = vi.fn(async () => {
    const next = overrides.toc ?? toc(2)
    return typeof next === 'function' ? next() : next
  })
  const lookup = vi.fn(async () => {
    const next =
      overrides.lookup ??
      ({ discId: 'x', candidates: [proposal('manual')] } satisfies DiscLookupResult)
    return typeof next === 'function' ? next() : next
  })
  const validateDestination = vi.fn(
    async (): Promise<RipDestinationResult> => overrides.dest ?? { ok: true, rootId: 1, relDir: '' }
  )
  const pickDestination = vi.fn(async () => '/library')
  const start = vi.fn(overrides.start ?? (async () => report()))
  const cancel = vi.fn(async () => undefined)
  const unfinishedSession = vi.fn(async () => overrides.offer ?? null)
  const resume = vi.fn(overrides.resume ?? (async () => report()))
  const dismissSession = vi.fn(async () => null)
  const listeners: Array<(progress: RipProgress) => void> = []

  const cdrip: CdRipBridge = {
    listDrives,
    readToc,
    lookup,
    validateDestination,
    pickArtwork: vi.fn(async () => null),
    pickDestination,
    start,
    cancel,
    unfinishedSession,
    resume,
    dismissSession,
    onProgress: (listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  }

  let destination = overrides.destination ?? '/library'
  let template = '{album}/{track:02} {title}'
  const cancelLookups = vi.fn()

  const deps: CdRipSessionDeps = {
    cdrip,
    cancelLookups,
    settings: {
      getDestination: () => destination,
      setDestination: (path) => {
        destination = path
      },
      getTemplate: () => template,
      setTemplate: (next) => {
        template = next
      },
      getVerify: () => false,
      lookupsAllowed: () => overrides.lookupsAllowed ?? true
    },
    rootPaths: () => [{ id: 1, path: '/library' }],
    markLibraryChanged: vi.fn()
  }

  const session = createCdRipSession(deps)
  return {
    session,
    cdrip,
    listDrives,
    readToc,
    lookup,
    cancel,
    start,
    resume,
    unfinishedSession,
    dismissSession,
    cancelLookups,
    markLibraryChanged: deps.markLibraryChanged,
    emitProgress: (progress: RipProgress) => {
      for (const listener of listeners) listener(progress)
    }
  }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('cdRipSession poll', () => {
  it('uses the global receiver for browser timers when opening and closing the pane', async () => {
    vi.useFakeTimers()
    const set = globalThis.setInterval
    const clear = globalThis.clearInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(function (this: unknown, handler, ms) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return set(handler, ms)
    })
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(function (this: unknown, id) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      clear(id)
    })

    const { session, listDrives } = harness({ drives: [] })
    for (let visit = 0; visit < 2; visit++) {
      expect(() => session.startPolling()).not.toThrow()
      await settle()
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(listDrives).toHaveBeenCalledTimes((visit + 1) * 2)
      expect(() => session.stopPolling()).not.toThrow()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(listDrives).toHaveBeenCalledTimes((visit + 1) * 2)
    }
  })

  it('stops polling when stopPolling is called — a leaked interval is the defect', async () => {
    vi.useFakeTimers()
    const { session, listDrives } = harness({ drives: [] })
    session.startPolling()
    await settle()
    expect(listDrives).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(listDrives).toHaveBeenCalledTimes(2)
    session.stopPolling()
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(listDrives).toHaveBeenCalledTimes(2)
    expect(session.detection.value).toBe('no-drive')
  })

  it('keeps the no-drive state when the drive list itself fails, with the error visible', async () => {
    vi.useFakeTimers()
    const { session, listDrives } = harness()
    listDrives.mockRejectedValue(
      new OscineError('io-error', 'The optical drive addon could not be loaded.')
    )
    session.startPolling()
    await settle()
    expect(listDrives).toHaveBeenCalled()
    expect(session.detection.value).toBe('no-drive')
    expect(session.notice.value).toBe('The optical drive addon could not be loaded.')
  })

  it('maps an empty tray onto the no-disc state', async () => {
    vi.useFakeTimers()
    const { session, readToc } = harness({
      toc: async () => {
        throw new OscineError('not-found', 'No disc in the drive.')
      }
    })
    session.startPolling()
    await settle()
    expect(readToc).toHaveBeenCalled()
    expect(session.detection.value).toBe('no-disc')
  })

  it('says a data-only disc is not audio rather than showing an empty table', async () => {
    vi.useFakeTimers()
    const { session } = harness({ toc: toc(0, 1) })
    session.startPolling()
    await settle()
    expect(session.detection.value).toBe('not-audio')
    expect(session.tracks.value).toHaveLength(0)
  })
})

describe('cdRipSession lookup', () => {
  it('skips the picker when consent is off and seeds the table with placeholders', async () => {
    vi.useFakeTimers()
    const { session } = harness({
      lookupsAllowed: false,
      lookup: { discId: 'x', candidates: [proposal('manual')] }
    })
    session.startPolling()
    await settle()
    await settle()
    expect(session.showPicker.value).toBe(false)
    expect(session.tracks.value).toHaveLength(2)
    expect(session.tracks.value[0]?.title).toBe('')
    expect(session.quietLine.value).toMatch(/online lookups are off/i)
  })

  it('does not pre-select a MusicBrainz candidate', async () => {
    vi.useFakeTimers()
    const candidates = [
      proposal('musicbrainz', {
        album: 'One',
        albumArtist: 'A',
        releaseMbid: '11111111-1111-4111-8111-111111111111',
        tracks: [
          { number: 1, title: 'One', artist: 'A' },
          { number: 2, title: 'Two', artist: 'A' }
        ]
      }),
      proposal('musicbrainz', {
        album: 'Two',
        albumArtist: 'A',
        releaseMbid: '22222222-2222-4222-8222-222222222222',
        tracks: [
          { number: 1, title: 'Uno', artist: 'A' },
          { number: 2, title: 'Dos', artist: 'A' }
        ]
      })
    ]
    const { session } = harness({ lookup: { discId: 'x', candidates } })
    session.startPolling()
    await settle()
    expect(session.showPicker.value).toBe(true)
    expect(session.selectedCandidate.value).toBeNull()
    expect(session.album.value).toBe('')
    session.selectCandidate(1)
    session.confirmCandidate()
    expect(session.album.value).toBe('Two')
    expect(session.tracks.value[0]?.title).toBe('Uno')
    expect(session.showPicker.value).toBe(false)
  })
})

describe('cdRipSession rip', () => {
  it.each(['replacement', 'empty tray', 'disconnected drive', 'data disc'] as const)(
    'clears completed outcomes on %s while preserving results for the same disc',
    async (change) => {
      vi.useFakeTimers()
      const { session, readToc, listDrives, emitProgress } = harness()
      session.startPolling()
      await settle()
      session.setCollision('skip')
      const pending = session.startRip()
      emitProgress({
        trackNumber: 1,
        trackIndex: 0,
        trackCount: 2,
        phase: 'reading',
        sectorsDone: 150,
        sectorsTotal: 150
      })
      await pending
      expect(session.status.value).toBe('done')
      expect(session.report.value?.outcomes).toHaveLength(1)
      expect(session.progress.value).not.toBeNull()

      await session.refresh()
      expect(session.status.value).toBe('done')
      expect(session.report.value?.outcomes).toHaveLength(1)

      if (change === 'replacement') readToc.mockResolvedValue(toc(3))
      else if (change === 'empty tray') {
        readToc.mockRejectedValue(new OscineError('not-found', 'No disc in the drive.'))
      } else if (change === 'disconnected drive') listDrives.mockResolvedValue([])
      else readToc.mockResolvedValue(toc(0, 1))

      await session.refresh()
      expect(session.status.value).toBe('idle')
      expect(session.report.value).toBeNull()
      expect(session.progress.value).toBeNull()
      expect(session.tracks.value).toHaveLength(change === 'replacement' ? 3 : 0)
      expect(session.destination.value).toBe('/library')
      expect(session.template.value).toBe('{album}/{track:02} {title}')
      expect(session.collision.value).toBe('skip')
    }
  )

  it('disables Rip while the destination is invalid', async () => {
    vi.useFakeTimers()
    const { session } = harness({ dest: { ok: false, reason: 'outside-roots' } })
    session.startPolling()
    await settle()
    expect(session.ripEnabled.value).toBe(false)
    expect(session.destReason.value).toMatch(/not inside a library folder/i)
  })

  it('dispatches cancel immediately during a running rip', async () => {
    vi.useFakeTimers()
    let release!: (report: RipReport) => void
    const { session, cancel, start } = harness({
      start: () =>
        new Promise<RipReport>((resolve) => {
          release = resolve
        })
    })
    session.startPolling()
    await settle()
    const pending = session.startRip()
    expect(start).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('ripping')
    session.cancelRip()
    expect(cancel).toHaveBeenCalledTimes(1)
    release(report({ cancelled: true }))
    await pending
    expect(session.report.value?.cancelled).toBe(true)
  })

  it('seeds one draft row per audio track, including a 99-track disc', async () => {
    vi.useFakeTimers()
    const { session } = harness({ toc: toc(99) })
    session.startPolling()
    await settle()
    expect(session.tracks.value).toHaveLength(99)
    expect(session.detection.value).toBe('ready')
  })

  it('offers resume when the unfinished session matches the disc in the drive', async () => {
    vi.useFakeTimers()
    const disc = toc(2)
    const offer: RipResumeOffer = {
      sessionId: 7,
      discId: computeDiscId(disc),
      tocHash: 'hash',
      album: 'Kid A',
      albumArtist: 'Radiohead',
      total: 12,
      remaining: 4,
      written: 8
    }
    const { session, resume, unfinishedSession } = harness({ toc: disc, offer })
    session.startPolling()
    await settle()
    expect(unfinishedSession).toHaveBeenCalled()
    expect(session.canResume.value).toBe(true)
    expect(session.resumeText.value).toBe('Resume ripping Kid A — 4 of 12 tracks remaining.')
    expect(session.showPicker.value).toBe(false)

    const pending = session.resumeRip()
    expect(resume).toHaveBeenCalledWith({
      sessionId: 7,
      driveId: 'sr0',
      onCollision: 'suffix'
    })
    await pending
    expect(session.status.value).toBe('done')
  })

  it('does not offer resume for a different disc', async () => {
    vi.useFakeTimers()
    const { session } = harness({
      offer: {
        sessionId: 7,
        discId: 'other-disc',
        tocHash: 'hash',
        album: 'Kid A',
        albumArtist: 'Radiohead',
        total: 12,
        remaining: 4,
        written: 8
      }
    })
    session.startPolling()
    await settle()
    expect(session.canResume.value).toBe(false)
  })

  it('dismisses the unfinished session without starting a rip', async () => {
    vi.useFakeTimers()
    const disc = toc(2)
    const offer: RipResumeOffer = {
      sessionId: 7,
      discId: computeDiscId(disc),
      tocHash: 'hash',
      album: 'Kid A',
      albumArtist: 'Radiohead',
      total: 12,
      remaining: 4,
      written: 8
    }
    const { session, dismissSession, unfinishedSession, start } = harness({ toc: disc, offer })
    session.startPolling()
    await settle()
    unfinishedSession.mockResolvedValue(null)
    await session.dismissResume()
    expect(dismissSession).toHaveBeenCalledWith(7)
    expect(start).not.toHaveBeenCalled()
    expect(session.canResume.value).toBe(false)
  })
})

describe('rip artwork draft', () => {
  const cover = { present: true, hash: 'a'.repeat(64), mime: 'image/png' }

  it('keeps a chosen cover on picker cancellation, sends it with the rip, and supports removal', async () => {
    const { session, cdrip, start } = harness()
    vi.useFakeTimers()
    session.startPolling()
    await settle()
    cdrip.pickArtwork = vi.fn(async () => cover)
    await session.pickArtwork()
    expect(session.artwork.value).toEqual(cover)
    cdrip.pickArtwork = vi.fn(async () => null)
    await session.pickArtwork()
    expect(session.artwork.value).toEqual(cover)
    await session.startRip()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ artworkHash: cover.hash }))
    session.removeArtwork()
    expect(session.artwork.value).toBeNull()
  })

  it('ignores a picker result for an ejected disc and disables ripping while picking', async () => {
    const { session, cdrip } = harness()
    vi.useFakeTimers()
    session.startPolling()
    await settle()
    let resolve!: (value: typeof cover) => void
    cdrip.pickArtwork = () =>
      new Promise((done) => {
        resolve = done
      })
    const pending = session.pickArtwork()
    expect(session.ripEnabled.value).toBe(false)
    cdrip.listDrives = async () => []
    await session.refresh()
    resolve(cover)
    await pending
    expect(session.artwork.value).toBeNull()
    expect(session.pickingArtwork.value).toBe(false)
  })

  it('shows picker errors without losing the previous cover', async () => {
    const { session, cdrip } = harness()
    cdrip.pickArtwork = async () => cover
    await session.pickArtwork()
    cdrip.pickArtwork = async () => {
      throw new Error('Choose a JPEG or PNG image.')
    }
    await session.pickArtwork()
    expect(session.artwork.value).toEqual(cover)
    expect(session.artworkError.value).toContain('JPEG or PNG')
  })
})
