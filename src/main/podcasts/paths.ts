import { basename, extname, join, posix } from 'node:path'

/**
 * Paths under the podcasts download root.
 *
 * Same invariant as library tracks: store POSIX-relative, rejoin per-platform
 * on read. The root itself is machine-local (`userData/podcasts`).
 */

// eslint-disable-next-line no-control-regex -- stripping control chars from titles is the point
const UNSAFE = /[<>:"|?*\u0000-\u001f]/g
const SLASHES = /[\\/]+/g

export function podcastDirName(podcastId: number, title: string): string {
  const slug = slugify(title) || 'podcast'
  return `${podcastId}-${slug}`
}

export function episodeFileName(episodeId: number, title: string, enclosureUrl: string): string {
  const ext = extensionFromUrl(enclosureUrl) || '.mp3'
  const slug = slugify(title) || 'episode'
  return `${episodeId}-${slug}${ext}`
}

export function episodeRelPath(
  podcastId: number,
  podcastTitle: string,
  episodeId: number,
  episodeTitle: string,
  enclosureUrl: string
): string {
  return posix.join(
    podcastDirName(podcastId, podcastTitle),
    episodeFileName(episodeId, episodeTitle, enclosureUrl)
  )
}

export function resolveEpisodeAbsPath(podcastsRoot: string, relPath: string): string {
  // Reject absolute / escaping paths the same way library paths do: only join.
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '..')
  return join(podcastsRoot, ...segments)
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(UNSAFE, '')
    .replace(SLASHES, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .toLowerCase()
}

function extensionFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const ext = extname(basename(path)).toLowerCase()
    if (ext.length >= 2 && ext.length <= 5 && /^\.[a-z0-9]+$/.test(ext)) return ext
  } catch {
    // Fall through.
  }
  return ''
}
