import type { RipDestinationRoot } from '@shared/cdrip'
import type { RipService } from '../cdrip/service'
import { validateRipDestination } from '../cdrip/destination'
import {
  assertCdripAbsDirRequest,
  assertCdripDriveIdRequest,
  assertRipDismissSessionRequest,
  assertRipRequest,
  assertRipResumeRequest
} from './validate'
import { emit, handle } from './registry'

export interface CdripHandlerDeps {
  rip: RipService
  /** Native folder picker; `null` when the operator dismisses it. */
  pickDestination: () => Promise<string | null>
  listRoots: () => Promise<readonly RipDestinationRoot[]>
}

/**
 * CD-rip channels — **W18-5 / W18-7**. Handlers stay thin: validate, delegate,
 * return. Progress goes only to the renderer that started the rip.
 */
export function registerCdripHandlers(deps: CdripHandlerDeps): void {
  const { rip, pickDestination, listRoots } = deps

  handle('cdrip.listDrives', () => rip.listDrives())

  handle('cdrip.readToc', (request) => {
    const { driveId } = assertCdripDriveIdRequest(request)
    return rip.readToc(driveId)
  })

  handle('cdrip.lookup', async (request) => {
    const { driveId } = assertCdripDriveIdRequest(request)
    const toc = await rip.readToc(driveId)
    return rip.lookupDisc(toc)
  })

  handle('cdrip.validateDestination', async (request) => {
    const { absDir } = assertCdripAbsDirRequest(request)
    const roots = await listRoots()
    return validateRipDestination(absDir, roots)
  })

  handle('cdrip.pickArtwork', () => rip.pickArtwork())

  handle('cdrip.pickDestination', () => pickDestination())

  handle('cdrip.unfinished', () => rip.unfinishedSession())

  handle('cdrip.resume', (request, event) => {
    const resumeRequest = assertRipResumeRequest(request)
    return rip.resume(resumeRequest, (progress) => emit(event.sender, 'cdrip.progress', progress))
  })

  handle('cdrip.dismiss', (request) => {
    const { sessionId } = assertRipDismissSessionRequest(request)
    rip.dismissSession(sessionId)
    return null
  })

  handle('cdrip.start', (request, event) => {
    const ripRequest = assertRipRequest(request)
    return rip.start(ripRequest, (progress) => emit(event.sender, 'cdrip.progress', progress))
  })

  handle('cdrip.cancel', () => {
    rip.cancel()
    return null
  })
}
