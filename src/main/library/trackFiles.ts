import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { TRACK_SCHEME } from '@shared/ipc'
import type { LibraryService } from './service'

/**
 * Serving track bytes to the renderer.
 *
 * The renderer needs playable bytes for `decodeAudioData`, but design section 6
 * forbids it touching the filesystem. This resolves the tension with a custom
 * protocol: the renderer fetches `fermata://track/<id>`, main maps the id to a
 * path, and the path never leaves main.
 *
 * The alternative — main handing back a validated `file://` URL — was rejected.
 * It would still disclose the user's filesystem layout to the renderer, and a
 * `file://` URL in renderer hands is one string-concatenation bug away from
 * being an arbitrary-file-read primitive. Resolution goes through a track id in
 * both designs; only this one also keeps paths out of the renderer entirely.
 */

/**
 * Must run before `app.whenReady()`.
 *
 * `standard` gives the scheme a real origin, which is what lets CSP reason
 * about it. `stream` matters for large FLAC files — without it Electron
 * buffers the whole response. `supportFetchAPI` is required because the
 * renderer reaches this through `fetch`.
 */
export function registerTrackScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: TRACK_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/** Must run after `app.whenReady()`. */
export function registerTrackProtocol(library: LibraryService): void {
  protocol.handle(TRACK_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    if (url.hostname !== 'track') {
      return new Response('Not found', { status: 404 })
    }

    // Exactly one path segment, and it must be a plain positive integer. This
    // is the check that keeps the scheme from becoming a path-traversal vector.
    const segment = url.pathname.replace(/^\//, '')
    if (!/^[1-9][0-9]*$/.test(segment)) {
      return new Response('Bad request', { status: 400 })
    }

    const trackId = Number(segment)
    let absolutePath: string | null
    try {
      absolutePath = await library.resolveTrackPath(trackId)
    } catch (err) {
      console.error(`[${TRACK_SCHEME}] failed to resolve track ${trackId}:`, err)
      return new Response('Internal error', { status: 500 })
    }

    if (!absolutePath) {
      return new Response('Not found', { status: 404 })
    }

    // Preserve a media element's Range request: seeking must not restart a
    // long track from byte zero. Only the one relevant request header crosses
    // to file:, rather than forwarding renderer-controlled headers wholesale.
    const upstreamHeaders = new Headers()
    const range = request.headers.get('range')
    if (range) upstreamHeaders.set('range', range)
    const upstream = await net.fetch(pathToFileURL(absolutePath).toString(), {
      headers: upstreamHeaders
    })

    // The renderer and fermata: have different origins in development.
    // Explicit CORS response headers keep MediaElementAudioSourceNode origin
    // clean, so the graph is audible rather than silently producing zeros.
    const headers = new Headers(upstream.headers)
    headers.set('access-control-allow-origin', '*')
    headers.set('access-control-expose-headers', 'accept-ranges, content-length, content-range')
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    })
  })
}
