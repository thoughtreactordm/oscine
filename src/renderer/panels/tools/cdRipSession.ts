import { computed, ref } from 'vue'
import { OscineError } from '@shared/errors'
import {
  audioTocEntries,
  computeDiscId,
  trackDurationSec,
  type CdDriveInfo,
  type CdToc,
  type DiscLookupResult,
  type DiscMetadataProposal,
  type RipCollision,
  type RipDestinationResult,
  type RipProgress,
  type RipReport,
  type RipRequest
} from '@shared/cdrip'
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
  POLL_MS,
  type RipDraftTrack
} from './cdRipModel'

/**
 * The Tools pane's session — **W18-7**. Poll lifecycle, lookup, destination
 * validation and the rip itself. Injectable so tests drive a mocked IPC
 * surface and fake timers without Pinia.
 */

export type RipPaneStatus = 'idle' | 'ripping' | 'done'

export interface CdRipBridge {
  listDrives(): Promise<CdDriveInfo[]>
  readToc(driveId: string): Promise<CdToc>
  lookup(driveId: string): Promise<DiscLookupResult>
  validateDestination(absDir: string): Promise<RipDestinationResult>
  pickDestination(): Promise<string | null>
  start(request: RipRequest): Promise<RipReport>
  cancel(): Promise<void | null>
  onProgress(listener: (progress: RipProgress) => void): () => void
}

export interface CdRipSettings {
  getDestination(): string
  setDestination(path: string): void
  getTemplate(): string
  setTemplate(template: string): void
  getVerify(): boolean
  lookupsAllowed(): boolean
}

export interface CdRipSessionDeps {
  cdrip: CdRipBridge
  cancelLookups: () => void
  settings: CdRipSettings
  rootPaths: () => readonly { id: number; path: string }[]
  markLibraryChanged: () => void
  interval?: {
    set: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
    clear: (id: ReturnType<typeof setInterval>) => void
  }
}

export function createCdRipSession(deps: CdRipSessionDeps) {
  // Browser timers require the global receiver, not the clock adapter object.
  const clock = deps.interval ?? {
    set: (handler: () => void, ms: number) => globalThis.setInterval(handler, ms),
    clear: (id: ReturnType<typeof setInterval>) => globalThis.clearInterval(id)
  }

  const drives = ref<CdDriveInfo[]>([])
  const driveId = ref<string | null>(null)
  const toc = ref<CdToc | null>(null)
  const noDisc = ref(false)
  const notice = ref<string | null>(null)

  const discId = ref<string | null>(null)
  const candidates = ref<DiscMetadataProposal[]>([])
  const selectedCandidate = ref<number | null>(null)
  const pickerSettled = ref(false)
  const lookingUp = ref(false)

  const album = ref('')
  const albumArtist = ref('')
  const year = ref<number | null>(null)
  const tracks = ref<RipDraftTrack[]>([])

  const destination = ref(deps.settings.getDestination())
  const template = ref(deps.settings.getTemplate())
  const destResult = ref<RipDestinationResult | null>(null)
  const collision = ref<RipCollision>('suffix')

  const status = ref<RipPaneStatus>('idle')
  const progress = ref<RipProgress | null>(null)
  const report = ref<RipReport | null>(null)

  let pollId: ReturnType<typeof setInterval> | null = null
  let pollInFlight = false
  let lookupSeq = 0
  let destSeq = 0
  let started = false

  const detection = computed(() =>
    discDetection({ drives: drives.value, toc: toc.value, noDisc: noDisc.value })
  )
  const summary = computed(() => (toc.value ? discSummary(toc.value) : null))
  const showPicker = computed(
    () => needsReleasePick(candidates.value) && !pickerSettled.value && status.value !== 'ripping'
  )
  const quietLine = computed(() =>
    unmatchedNote({
      lookupsAllowed: deps.settings.lookupsAllowed(),
      candidates: candidates.value,
      pickerSettled: pickerSettled.value
    })
  )
  const preview = computed(() =>
    pathPreview({
      template: template.value,
      album: album.value,
      albumArtist: albumArtist.value,
      year: year.value,
      tracks: tracks.value
    })
  )
  const destReason = computed(() => destinationReason(destination.value, destResult.value))
  const includedCount = computed(() => tracks.value.filter((track) => track.included).length)
  const headerState = computed(() => includeState(tracks.value.length, includedCount.value))
  const destinationOk = computed(() => destResult.value?.ok === true)
  const ripping = computed(() => status.value === 'ripping')
  const ripEnabled = computed(() =>
    canRip({
      detection: detection.value,
      ripping: ripping.value,
      included: includedCount.value,
      destinationOk: destinationOk.value
    })
  )

  function resetDraft(): void {
    // Completed outcomes belong to the previous disc, just like its metadata.
    if (status.value !== 'ripping') dismissReport()
    album.value = ''
    albumArtist.value = ''
    year.value = null
    tracks.value = []
    candidates.value = []
    selectedCandidate.value = null
    pickerSettled.value = false
    lookingUp.value = false
  }

  function clearDisc(): void {
    driveId.value = null
    toc.value = null
    noDisc.value = false
    discId.value = null
    notice.value = null
    resetDraft()
  }

  function seedTracks(next: CdToc): void {
    tracks.value = audioTocEntries(next).map((entry) => ({
      number: entry.number,
      title: '',
      artist: '',
      included: true
    }))
  }

  function applyCandidate(proposal: DiscMetadataProposal): void {
    album.value = proposal.album
    albumArtist.value = proposal.albumArtist
    year.value = proposal.year
    tracks.value = applyProposal(tracks.value, proposal)
  }

  async function lookupDisc(id: string): Promise<void> {
    const seq = ++lookupSeq
    lookingUp.value = true
    try {
      const result = await deps.cdrip.lookup(id)
      if (seq !== lookupSeq) return
      candidates.value = result.candidates
      if (needsReleasePick(result.candidates)) {
        selectedCandidate.value = null
        pickerSettled.value = false
        return
      }
      pickerSettled.value = true
      const fallback = result.candidates[0]
      if (fallback) applyCandidate(fallback)
    } catch (error) {
      if (seq !== lookupSeq) return
      notice.value = error instanceof Error ? error.message : 'The disc lookup failed.'
      pickerSettled.value = true
    } finally {
      if (seq === lookupSeq) lookingUp.value = false
    }
  }

  function acceptDisc(id: string, next: CdToc): void {
    const previousDrive = driveId.value
    driveId.value = id
    toc.value = next
    noDisc.value = false
    notice.value = null
    if (audioTocEntries(next).length === 0) {
      discId.value = null
      resetDraft()
      return
    }
    const nextId = computeDiscId(next)
    if (discId.value === nextId && previousDrive === id) return
    discId.value = nextId
    resetDraft()
    seedTracks(next)
    if (status.value !== 'ripping') void lookupDisc(id)
  }

  function tocFailed(error: unknown): void {
    if (error instanceof OscineError && error.code === 'not-found') {
      noDisc.value = true
      toc.value = null
      discId.value = null
      resetDraft()
      notice.value = null
      return
    }
    // A busy drive during a running rip is expected; keep the last TOC.
    if (status.value === 'ripping') return
    if (error instanceof OscineError && error.code === 'conflict' && toc.value !== null) return
    notice.value = error instanceof Error ? error.message : 'The disc could not be read.'
  }

  async function pollOnce(): Promise<void> {
    if (pollInFlight || status.value === 'ripping') return
    pollInFlight = true
    try {
      const listed = await deps.cdrip.listDrives()
      drives.value = listed
      if (listed.length === 0) {
        clearDisc()
        return
      }
      const keep =
        driveId.value !== null && listed.some((drive) => drive.id === driveId.value)
          ? driveId.value
          : listed[0]!.id
      try {
        acceptDisc(keep, await deps.cdrip.readToc(keep))
      } catch (error) {
        tocFailed(error)
      }
    } catch (error) {
      notice.value = error instanceof Error ? error.message : 'The drive list could not be read.'
    } finally {
      pollInFlight = false
    }
  }

  function startPolling(): void {
    if (started) return
    started = true
    destination.value = deps.settings.getDestination()
    template.value = deps.settings.getTemplate()
    if (destination.value.trim() === '') {
      const first = deps.rootPaths()[0]
      if (first) {
        destination.value = first.path
        deps.settings.setDestination(first.path)
      }
    }
    void validateDestination()
    void pollOnce()
    pollId = clock.set(() => {
      void pollOnce()
    }, POLL_MS)
  }

  function stopPolling(): void {
    started = false
    if (pollId !== null) {
      clock.clear(pollId)
      pollId = null
    }
    lookupSeq += 1
    lookingUp.value = false
    deps.cancelLookups()
  }

  async function refresh(): Promise<void> {
    await pollOnce()
  }

  async function validateDestination(): Promise<void> {
    const absDir = destination.value.trim()
    if (absDir === '') {
      destResult.value = { ok: false, reason: 'outside-roots' }
      return
    }
    const seq = ++destSeq
    try {
      const result = await deps.cdrip.validateDestination(absDir)
      if (seq !== destSeq) return
      destResult.value = result
    } catch {
      if (seq !== destSeq) return
      destResult.value = { ok: false, reason: 'not-writable' }
    }
  }

  async function pickDestination(): Promise<void> {
    const picked = await deps.cdrip.pickDestination()
    if (picked === null) return
    destination.value = picked
    deps.settings.setDestination(picked)
    await validateDestination()
  }

  function setTemplate(next: string): void {
    template.value = next
    deps.settings.setTemplate(next)
  }

  function setDestinationPath(next: string): void {
    destination.value = next
    deps.settings.setDestination(next)
    void validateDestination()
  }

  function setCollision(next: RipCollision): void {
    collision.value = next
  }

  function setAlbum(next: string): void {
    album.value = next
  }

  function setAlbumArtist(next: string): void {
    albumArtist.value = next
  }

  function setYear(next: number | null): void {
    year.value = next
  }

  function setTrackTitle(number: number, title: string): void {
    const row = tracks.value.find((track) => track.number === number)
    if (row) row.title = title
  }

  function setTrackArtist(number: number, artist: string): void {
    const row = tracks.value.find((track) => track.number === number)
    if (row) row.artist = artist
  }

  function toggleIncluded(number: number): void {
    const row = tracks.value.find((track) => track.number === number)
    if (row) row.included = !row.included
  }

  function setAllIncluded(on: boolean): void {
    for (const track of tracks.value) track.included = on
  }

  function selectCandidate(index: number): void {
    if (index < 0 || index >= candidates.value.length) return
    selectedCandidate.value = index
  }

  function confirmCandidate(): void {
    const index = selectedCandidate.value
    if (index === null) return
    const proposal = candidates.value[index]
    if (!proposal) return
    applyCandidate(proposal)
    pickerSettled.value = true
  }

  function skipPicker(): void {
    pickerSettled.value = true
  }

  function buildRequest(): RipRequest | null {
    const id = driveId.value
    const dest = destResult.value
    if (id === null || dest === null || !dest.ok) return null
    const selected = tracks.value.filter((track) => track.included)
    if (selected.length === 0) return null
    return {
      driveId: id,
      rootId: dest.rootId,
      relDir: dest.relDir,
      template: template.value,
      tracks: selected.map((track) => ({
        number: track.number,
        title: track.title,
        artist: track.artist
      })),
      album: album.value,
      albumArtist: albumArtist.value,
      year: year.value,
      verify: deps.settings.getVerify(),
      onCollision: collision.value
    }
  }

  async function startRip(): Promise<void> {
    if (!ripEnabled.value) return
    const request = buildRequest()
    if (request === null) return
    status.value = 'ripping'
    report.value = null
    progress.value = null
    notice.value = null
    try {
      report.value = await deps.cdrip.start(request)
      status.value = 'done'
      deps.markLibraryChanged()
    } catch (error) {
      status.value = 'idle'
      notice.value = error instanceof Error ? error.message : 'The rip could not start.'
    }
  }

  function cancelRip(): void {
    if (status.value === 'ripping') void deps.cdrip.cancel()
  }

  function dismissReport(): void {
    report.value = null
    progress.value = null
    if (status.value === 'done') status.value = 'idle'
  }

  deps.cdrip.onProgress((next) => {
    if (status.value === 'ripping') progress.value = next
  })

  return {
    drives,
    driveId,
    toc,
    notice,
    discId,
    candidates,
    selectedCandidate,
    pickerSettled,
    lookingUp,
    album,
    albumArtist,
    year,
    tracks,
    destination,
    template,
    destResult,
    collision,
    status,
    progress,
    report,
    detection,
    summary,
    showPicker,
    quietLine,
    preview,
    destReason,
    includedCount,
    headerState,
    destinationOk,
    ripping,
    ripEnabled,
    startPolling,
    stopPolling,
    refresh,
    pickDestination,
    validateDestination,
    setDestinationPath,
    setTemplate,
    setCollision,
    setAlbum,
    setAlbumArtist,
    setYear,
    setTrackTitle,
    setTrackArtist,
    toggleIncluded,
    setAllIncluded,
    selectCandidate,
    confirmCandidate,
    skipPicker,
    startRip,
    cancelRip,
    dismissReport,
    trackDurationSec: (number: number) => (toc.value ? trackDurationSec(toc.value, number) : 0)
  }
}

export type CdRipSession = ReturnType<typeof createCdRipSession>
