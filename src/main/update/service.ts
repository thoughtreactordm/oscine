/**
 * Manual in-app updates over GitHub Releases — **W6-6**.
 *
 * `electron-updater` is the driver for NSIS and AppImage. It is never
 * constructed in `npm run dev`, and it is never asked to download or install
 * on a `.deb` (or any other non-AppImage Linux tree): dpkg/apt owns that
 * install, and even though current electron-updater ships a `DebUpdater` that
 * will `dpkg -i` under sudo, that is the path the card ruled out. Those
 * installs learn about a newer tag by reading `latest-linux.yml` and are
 * pointed at the releases page.
 *
 * The driver is injected so a test never loads `electron-updater` (and so
 * never loads Electron). Production wiring lives in `index.ts`.
 */

import { OscineError } from '@shared/errors'
import {
  compareVersions,
  detectUpdateChannel,
  OSCINE_RELEASES_URL,
  updateChannelCanSelfUpdate,
  type UpdateDownloadProgress,
  type UpdateInstallChannel,
  type UpdateStatus,
  type UpdateStatusKind
} from '@shared/update'

export interface AppUpdateDriver {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  isUpdaterActive(): boolean
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (progress: UpdateDownloadProgress) => void): this
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

export interface UpdateHost {
  readonly isPackaged: boolean
  readonly platform: string
  readonly appImagePath: string | undefined
  readonly currentVersion: string
  readonly updater: AppUpdateDriver | null
  /**
   * The version electron-builder published as `latest.yml` / `latest-linux.yml`.
   *
   * Used when the install cannot self-update (deb, unpacked). The AppImage and
   * NSIS paths go through the driver instead, so they do not double-fetch.
   */
  readPublishedVersion: () => Promise<string>
}

export interface UpdateService {
  status(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  install(): void
}

const CHECK_UNAVAILABLE = 'No update is ready to download.'
const INSTALL_UNAVAILABLE = 'No update is ready to install.'

export function createUpdateService(
  host: UpdateHost,
  onChange: (status: UpdateStatus) => void
): UpdateService {
  const channel = detectUpdateChannel(host)
  const canSelfUpdate = updateChannelCanSelfUpdate(channel)

  let current = initialStatus(channel, host.currentVersion)
  let inFlight: Promise<UpdateStatus> | null = null

  const emit = (next: UpdateStatus): UpdateStatus => {
    // A successful state carries no detail. The success emits all spread the
    // previous status, so without this an `errorDetail` from an earlier failure
    // would linger past the recovery; clearing it here means only `fail` ever
    // sets one, and no emit site has to remember to reset it.
    current = next.error === null ? { ...next, errorDetail: null } : next
    onChange(current)
    return current
  }

  const fail = (error: unknown): UpdateStatus => {
    const { message, detail } = describeUpdateError(error)
    return emit({
      ...current,
      kind: 'error',
      progress: null,
      error: message,
      errorDetail: detail
    })
  }

  const updater = host.updater
  if (updater && canSelfUpdate) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('download-progress', (progress) => {
      emit({
        ...current,
        kind: 'downloading',
        progress: {
          percent: progress.percent,
          bytesPerSecond: progress.bytesPerSecond,
          transferred: progress.transferred,
          total: progress.total
        },
        error: null
      })
    })
    updater.on('update-downloaded', (info) => {
      emit({
        ...current,
        kind: 'ready',
        availableVersion: info.version,
        progress: null,
        error: null
      })
    })
    updater.on('error', (error) => {
      fail(error)
    })
  }

  const availableKind: UpdateStatusKind = canSelfUpdate ? 'available' : 'available-external'

  async function runCheck(): Promise<UpdateStatus> {
    if (channel === 'dev') return current
    if (current.kind === 'downloading') return current

    emit({
      ...current,
      kind: 'checking',
      progress: null,
      error: null
    })

    try {
      const remote = canSelfUpdate
        ? await readDriverVersion(updater)
        : await host.readPublishedVersion()
      if (compareVersions(remote, host.currentVersion) > 0) {
        return emit({
          ...current,
          kind: availableKind,
          availableVersion: remote,
          progress: null,
          error: null
        })
      }
      return emit({
        ...current,
        kind: 'up-to-date',
        availableVersion: null,
        progress: null,
        error: null
      })
    } catch (error) {
      return fail(error)
    }
  }

  return {
    status: () => current,

    check(): Promise<UpdateStatus> {
      if (inFlight) return inFlight
      inFlight = runCheck().finally(() => {
        inFlight = null
      })
      return inFlight
    },

    async download(): Promise<UpdateStatus> {
      if (current.kind === 'available-external') return current
      if (current.kind === 'ready') return current
      if (current.kind !== 'available' || !updater || !canSelfUpdate) {
        throw new OscineError('conflict', CHECK_UNAVAILABLE)
      }
      emit({
        ...current,
        kind: 'downloading',
        progress: current.progress ?? {
          percent: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: 0
        },
        error: null
      })
      try {
        await updater.downloadUpdate()
        const latest: UpdateStatus = current
        if (latest.kind === 'ready' || latest.kind === 'error') return latest
        return emit({
          ...latest,
          kind: 'ready',
          progress: null,
          error: null
        })
      } catch (error) {
        return fail(error)
      }
    },

    install(): void {
      if (current.kind !== 'ready' || !updater || !canSelfUpdate) {
        throw new OscineError('conflict', INSTALL_UNAVAILABLE)
      }
      // Force-run after so "Restart to install" actually relaunches rather than
      // leaving the operator at the desktop. Silent is off: the unsigned NSIS
      // path already surfaces SmartScreen, and hiding that dialog would not
      // make the warning go away.
      updater.quitAndInstall(false, true)
    }
  }
}

function initialStatus(channel: UpdateInstallChannel, currentVersion: string): UpdateStatus {
  return {
    kind: channel === 'dev' ? 'unsupported' : 'idle',
    channel,
    currentVersion,
    availableVersion: null,
    progress: null,
    error: null,
    errorDetail: null,
    releasesUrl: OSCINE_RELEASES_URL
  }
}

async function readDriverVersion(updater: AppUpdateDriver | null): Promise<string> {
  if (!updater) {
    throw new Error('Updater is not available.')
  }
  if (!updater.isUpdaterActive()) {
    throw new Error('Updater is not active.')
  }
  const result = await updater.checkForUpdates()
  if (!result) {
    throw new Error('Updater returned no result.')
  }
  return result.updateInfo.version
}

/**
 * Split a thrown update error into the headline the operator reads and the raw
 * reason they act on. The headline stays friendly and categorised; the detail
 * is the driver/network message, trimmed to one line and capped so a stack-y
 * message cannot flood the settings panel. The full error is still logged.
 */
function describeUpdateError(error: unknown): { message: string; detail: string } {
  const raw = error instanceof Error ? error.message : String(error)
  console.error('[update]', error)
  return { message: friendlyUpdateMessage(raw), detail: trimDetail(raw) }
}

function friendlyUpdateMessage(raw: string): string {
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|fetch failed|HTTP 5\d\d/i.test(raw)) {
    return 'Oscine could not reach the update server.'
  }
  if (/HTTP 404|had no version|no result/i.test(raw)) {
    return 'No published update metadata was found.'
  }
  return 'The update could not be completed.'
}

const MAX_DETAIL_CHARS = 300

function trimDetail(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_DETAIL_CHARS ? `${oneLine.slice(0, MAX_DETAIL_CHARS - 1)}…` : oneLine
}
