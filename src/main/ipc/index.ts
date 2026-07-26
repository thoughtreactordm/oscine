import { FermataError } from '@shared/errors'
import { trackUrl } from '@shared/ipc'
import type { LibraryService } from '../library/service'
import { assertEveryChannelHandled, handle } from './registry'
import { assertListTracksQuery, assertPositiveInt, assertRecord } from './validate'

/**
 * Wires every channel in the contract to the library service.
 *
 * Handlers stay thin on purpose: validate, delegate, return. Anything they
 * throw is flattened by the registry before it reaches the renderer.
 */
export function registerIpcHandlers(library: LibraryService): void {
  handle('library.addRoot', () => library.addRoot())

  handle('library.listRoots', () => library.listRoots())

  handle('library.scanRoot', (request) => {
    const { rootId } = assertRecord(request, 'request')
    return library.scanRoot(assertPositiveInt(rootId, 'rootId'))
  })

  handle('library.listTracks', (request) => library.listTracks(assertListTracksQuery(request)))

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

  assertEveryChannelHandled()
}

export { emit, setTrustedRendererUrl } from './registry'
