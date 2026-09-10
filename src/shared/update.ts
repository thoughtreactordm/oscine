/**
 * In-app update contract — **W6-6**.
 *
 * Manual check-and-install over the GitHub Releases channel that already
 * publishes the NSIS installer, the AppImage and the deb. The shapes here are
 * what crosses IPC: main owns the updater, the renderer paints a status line,
 * and neither side invents a version string of its own.
 *
 * Nothing here imports Electron. The service that drives `electron-updater`
 * lives in main; this file is the vocabulary both sides share.
 */

export const OSCINE_GITHUB_OWNER = 'thoughtreactordm'
export const OSCINE_GITHUB_REPO = 'oscine'

export const OSCINE_RELEASES_URL =
  `https://github.com/${OSCINE_GITHUB_OWNER}/${OSCINE_GITHUB_REPO}/releases` as const

/**
 * How this install can take a newer build.
 *
 * `nsis` and `appimage` self-update in-process. `external` is everything
 * electron-updater must not touch — a `.deb`, an unpacked tree — and the
 * renderer offers the releases page instead of a download. `dev` is
 * `npm run dev`: the updater is not constructed.
 */
export type UpdateInstallChannel = 'nsis' | 'appimage' | 'external' | 'dev'

export type UpdateStatusKind =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'available-external'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateDownloadProgress {
  readonly percent: number
  readonly bytesPerSecond: number
  readonly transferred: number
  readonly total: number
}

export interface UpdateStatus {
  readonly kind: UpdateStatusKind
  readonly channel: UpdateInstallChannel
  readonly currentVersion: string
  readonly availableVersion: string | null
  readonly progress: UpdateDownloadProgress | null
  readonly error: string | null
  readonly releasesUrl: string
}

export function detectUpdateChannel(input: {
  readonly isPackaged: boolean
  readonly platform: string
  readonly appImagePath: string | undefined
}): UpdateInstallChannel {
  if (!input.isPackaged) return 'dev'
  if (input.platform === 'win32') return 'nsis'
  if (input.platform === 'linux' && Boolean(input.appImagePath)) return 'appimage'
  return 'external'
}

export function updateChannelCanSelfUpdate(channel: UpdateInstallChannel): boolean {
  return channel === 'nsis' || channel === 'appimage'
}

/** The electron-updater sidecar this platform's self-update reads. */
export function latestMetadataName(platform: string): 'latest.yml' | 'latest-linux.yml' {
  return platform === 'win32' ? 'latest.yml' : 'latest-linux.yml'
}

export function latestMetadataUrl(platform: string): string {
  return `${OSCINE_RELEASES_URL}/latest/download/${latestMetadataName(platform)}`
}

/**
 * Pull the `version:` field out of an electron-builder `latest.yml`.
 *
 * The file is tiny YAML with a stable shape; a full parser would be a
 * dependency for one key. Quoted and unquoted values both appear in the wild.
 */
export function parseLatestYmlVersion(text: string): string | null {
  const match = /^version:\s*["']?([^\s"']+)/m.exec(text.replace(/^\uFEFF/, ''))
  return match?.[1] ?? null
}

/**
 * Compare two dotted versions, optionally with a leading `v` and a `-pre` suffix.
 *
 * A prerelease is less than the same core with no suffix, so `1.0.0-rc` is
 * behind `1.0.0`. Numeric, not lexicographic: `1.10.0` is newer than `1.9.0`.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let i = 0; i < 3; i++) {
    const delta = a.core[i] - b.core[i]
    if (delta !== 0) return delta
  }
  if (a.prerelease === b.prerelease) return 0
  return a.prerelease ? -1 : 1
}

function parseVersion(raw: string): { core: [number, number, number]; prerelease: boolean } {
  const stripped = raw.trim().replace(/^v/i, '')
  const dash = stripped.indexOf('-')
  const prerelease = dash >= 0
  const core = (prerelease ? stripped.slice(0, dash) : stripped).split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
  return {
    core: [core[0] ?? 0, core[1] ?? 0, core[2] ?? 0],
    prerelease
  }
}
