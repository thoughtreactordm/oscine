import { net, protocol } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CATALOG_ARTWORK_HOST, isCatalogArtworkHost, TRACK_SCHEME } from '@shared/ipc'
import type { ArtworkVariant } from '@shared/library'
import type { NetworkConsent } from '../net'
import { OSCINE_USER_AGENT, readCappedBytes } from '../net/http'
import type { PodcastService } from '../podcasts/service'
import { parseByteRange, UNSATISFIABLE_RANGE } from './byteRange'
import type { LibraryService } from './service'

/**
 * Serving track bytes to the renderer.
 *
 * The renderer needs playable bytes for `decodeAudioData`, but design section 6
 * forbids it touching the filesystem. This resolves the tension with a custom
 * protocol: the renderer fetches `oscine://track/<id>`, main maps the id to a
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
export function registerTrackProtocol(
  library: LibraryService,
  artworkCacheDir: string,
  consent: NetworkConsent,
  podcasts?: PodcastService
): void {
  protocol.handle(TRACK_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    if (url.hostname === 'artwork') {
      return serveArtwork(url, artworkCacheDir)
    }

    if (url.hostname === CATALOG_ARTWORK_HOST) {
      return serveCatalogArtwork(url, consent)
    }

    if (url.hostname !== 'track' && url.hostname !== 'episode') {
      return new Response('Not found', { status: 404 })
    }

    // Exactly one path segment, and it must be a plain positive integer. This
    // is the check that keeps the scheme from becoming a path-traversal vector.
    const segment = url.pathname.replace(/^\//, '')
    if (!/^[1-9][0-9]*$/.test(segment)) {
      return new Response('Bad request', { status: 400 })
    }

    const id = Number(segment)
    let absolutePath: string | null
    try {
      absolutePath =
        url.hostname === 'episode'
          ? podcasts
            ? await podcasts.resolveEpisodePath(id)
            : null
          : await library.resolveTrackPath(id)
    } catch (err) {
      console.error(`[${TRACK_SCHEME}] failed to resolve ${url.hostname} ${id}:`, err)
      return new Response('Internal error', { status: 500 })
    }

    if (!absolutePath) {
      return new Response('Not found', { status: 404 })
    }

    return serveLocalFile(request, absolutePath)
  })
}

async function serveLocalFile(request: Request, absolutePath: string): Promise<Response> {
  let totalBytes: number
  try {
    totalBytes = (await stat(absolutePath)).size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  // Preserve a media element's Range request: seeking must not restart a
  // long track from byte zero. Only the one relevant request header crosses
  // to file:, rather than forwarding renderer-controlled headers wholesale.
  const requestedRange = parseByteRange(request.headers.get('range'), totalBytes)
  if (requestedRange === UNSATISFIABLE_RANGE) {
    return new Response(null, {
      status: 416,
      headers: {
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        'content-range': `bytes */${totalBytes}`
      }
    })
  }
  const upstreamHeaders = new Headers()
  const range = request.headers.get('range')
  if (range) upstreamHeaders.set('range', range)
  const upstream = await net.fetch(pathToFileURL(absolutePath).toString(), {
    headers: upstreamHeaders
  })

  // The renderer and oscine: have different origins in development.
  // Explicit CORS response headers keep MediaElementAudioSourceNode origin
  // clean, so the graph is audible rather than silently producing zeros.
  const headers = new Headers(upstream.headers)
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-expose-headers', 'accept-ranges, content-length, content-range')
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    })
  }

  headers.set('accept-ranges', 'bytes')
  headers.set(
    'content-length',
    String(requestedRange === null ? totalBytes : requestedRange.length)
  )
  if (requestedRange !== null) {
    headers.set(
      'content-range',
      `bytes ${requestedRange.start}-${requestedRange.end}/${totalBytes}`
    )
  }
  return new Response(upstream.body, {
    // Electron's file loader honors Range and returns the sliced bytes, but
    // reports them as 200 without Content-Range. Relabeling that payload is
    // what lets HTMLMediaElement preserve its timeline after a seek.
    status: requestedRange === null ? upstream.status : 206,
    statusText: upstream.statusText,
    headers
  })
}

const ARTWORK_HASH = /^[a-f0-9]{64}$/
const ARTWORK_VARIANTS = new Set<ArtworkVariant>(['small', 'large'])
const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">
  <rect width="1" height="1" fill="#18181b"/>
  <path d="M.22.68h.56V.32H.22v.36Zm.08-.08.13-.16.1.12.08-.09.09.13H.3Z" fill="#71717a"/>
</svg>`

async function serveArtwork(url: URL, cacheDir: string): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 2) return new Response('Bad request', { status: 400 })
  const [hash, variantValue] = segments
  if (!ARTWORK_VARIANTS.has(variantValue as ArtworkVariant)) {
    return new Response('Bad request', { status: 400 })
  }
  const variant = variantValue as ArtworkVariant
  if (hash === 'missing') return placeholderResponse()
  if (!ARTWORK_HASH.test(hash)) return new Response('Bad request', { status: 400 })

  const path = join(cacheDir, `${hash}-${variant}.webp`)
  try {
    await stat(path)
    const response = await net.fetch(pathToFileURL(path).toString())
    if (!response.ok) return placeholderResponse()
    const headers = new Headers(response.headers)
    headers.set('access-control-allow-origin', '*')
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    headers.set('content-type', 'image/webp')
    return new Response(response.body, { status: 200, headers })
  } catch {
    // Cache data is disposable. A missing/corrupt object is a placeholder now
    // and will be regenerated by the next artwork reconciliation.
    return placeholderResponse()
  }
}

/** A thumbnail is a thumbnail; anything larger than this is not one. */
const MAX_CATALOG_ARTWORK_BYTES = 4 * 1024 * 1024
const CATALOG_ARTWORK_TIMEOUT_MS = 15_000

/**
 * Fetches a Discover thumbnail on the renderer's behalf.
 *
 * A whole-transfer deadline is right here, unlike episode downloads: these are
 * capped at a few megabytes, so a slow-but-alive transfer that trips it was
 * never going to be a usable image anyway.
 */
async function serveCatalogArtwork(url: URL, consent: NetworkConsent): Promise<Response> {
  // D14's first rule, at the socket that would actually reach Apple's CDN. The
  // pane deciding whether to render an `<img>` is not the gate — this is, so a
  // stale render or a forgetful caller still cannot pull a thumbnail while
  // lookups are off. A placeholder rather than a 403: the row shows the same
  // neutral art it shows for any unreachable thumbnail, not an error.
  if (!consent.granted()) return placeholderResponse()

  const remote = url.searchParams.get('u')
  if (!remote) return new Response('Bad request', { status: 400 })

  let target: URL
  try {
    target = new URL(remote)
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  // Re-checked rather than trusted from the caller. `catalogArtworkUrl` filters
  // in the renderer for the renderer's benefit; this process is the one holding
  // the socket, so this is the check that actually constrains where it points.
  if (target.protocol !== 'https:' || !isCatalogArtworkHost(target.hostname)) {
    return new Response('Forbidden', { status: 403 })
  }

  let upstream: Response
  try {
    upstream = await net.fetch(target.toString(), {
      signal: AbortSignal.timeout(CATALOG_ARTWORK_TIMEOUT_MS),
      headers: { accept: 'image/*', 'user-agent': OSCINE_USER_AGENT }
    })
  } catch {
    return placeholderResponse()
  }

  const contentType = upstream.headers.get('content-type') ?? ''
  if (!upstream.ok || !contentType.startsWith('image/')) {
    await upstream.body?.cancel().catch(() => undefined)
    return placeholderResponse()
  }

  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = await readCappedBytes(upstream, MAX_CATALOG_ARTWORK_BYTES)
  } catch {
    return placeholderResponse()
  }

  return new Response(new Blob([bytes]), {
    status: 200,
    headers: {
      'access-control-allow-origin': '*',
      // Discover re-renders the same shelves constantly. Without this every
      // scroll back to a shelf is another round trip to Apple.
      'cache-control': 'public, max-age=86400',
      'content-type': contentType
    }
  })
}

function placeholderResponse(): Response {
  return new Response(PLACEHOLDER, {
    status: 200,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
      'content-type': 'image/svg+xml; charset=utf-8'
    }
  })
}
