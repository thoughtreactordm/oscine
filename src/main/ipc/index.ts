import { BrowserWindow } from 'electron'
import { FermataError } from '@shared/errors'
import { trackUrl } from '@shared/ipc'
import type { LibraryService } from '../library/service'
import { assertEveryChannelHandled, handle } from './registry'
import {
  assertListFacetsQuery,
  assertListTrackIdsQuery,
  assertListTracksQuery,
  assertOrderTrackIdsQuery,
  assertPositiveInt,
  assertRecord
} from './validate'

/**
 * Wires every channel in the contract to the library service.
 *
 * Handlers stay thin on purpose: validate, delegate, return. Anything they
 * throw is flattened by the registry before it reaches the renderer.
 */
export function registerIpcHandlers(library: LibraryService): void {
  handle('window.minimize', (_request, event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
    return null
  })

  handle('window.toggleMaximize', (_request, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  handle('window.isMaximized', (_request, event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  handle('window.close', (_request, event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return null
  })

  handle('library.addRoot', () => library.addRoot())

  handle('library.listRoots', () => library.listRoots())

  handle('library.scanRoot', (request) => {
    const { rootId } = assertRecord(request, 'request')
    return library.scanRoot(assertPositiveInt(rootId, 'rootId'))
  })

  handle('library.listArtists', (request) => library.listArtists(assertListFacetsQuery(request)))

  handle('library.listAlbums', (request) => library.listAlbums(assertListFacetsQuery(request)))

  handle('library.listTracks', (request) => library.listTracks(assertListTracksQuery(request)))

  handle('library.listTrackIds', (request) =>
    library.listTrackIds(assertListTrackIdsQuery(request))
  )

  handle('library.orderTrackIds', (request) =>
    library.orderTrackIds(assertOrderTrackIdsQuery(request))
  )

  handle('library.getTrackAudioMetadata', async (request) => {
    const { trackId } = assertRecord(request, 'request')
    const metadata = await library.getTrackAudioMetadata(assertPositiveInt(trackId, 'trackId'))
    if (!metadata) {
      throw new FermataError('not-found', 'That track is no longer in the library.')
    }
    return metadata
  })

  handle('library.getTrackFileUrl', async (request) => {
    const { trackId } = assertRecord(request, 'request')
    const id = assertPositiveInt(trackId, 'trackId')

    // Confirm the track exists before minting a URL, so a bad id fails here
    // with a clear error rather than as an opaque 404 during playback. The
    // resolved path is deliberately discarded — only the id goes back.
    if ((await library.resolveTrackPath(id)) === null) {
      throw new FermataError('not-found', 'That track is no longer in the library.')
    }
    return trackUrl(id)
  })

  handle('library.startReplayGain', () => library.startReplayGain())

  handle('library.getReplayGainJob', () => library.getReplayGainJob())

  handle('library.cancelReplayGain', (request) => {
    const { jobId } = assertRecord(request, 'request')
    return library.cancelReplayGain(assertPositiveInt(jobId, 'jobId'))
  })

  handle('library.resumeReplayGain', (request) => {
    const { jobId } = assertRecord(request, 'request')
    return library.resumeReplayGain(assertPositiveInt(jobId, 'jobId'))
  })

  assertEveryChannelHandled()
}

export { emit, setTrustedRendererUrl } from './registry'
