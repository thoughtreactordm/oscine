import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OscineError } from '../../../src/shared/errors'
import { OSCINE_RELEASES_URL, type UpdateDownloadProgress } from '../../../src/shared/update'
import {
  createUpdateService,
  type AppUpdateDriver,
  type UpdateHost
} from '../../../src/main/update/service'

class FakeUpdater extends EventEmitter implements AppUpdateDriver {
  autoDownload = true
  autoInstallOnAppQuit = true
  active = true
  remoteVersion = '1.0.3'
  checkImpl: (() => Promise<{ updateInfo: { version: string } } | null>) | null = null
  downloadImpl: (() => Promise<void>) | null = null
  installed = false

  isUpdaterActive(): boolean {
    return this.active
  }

  async checkForUpdates(): Promise<{ updateInfo: { version: string } } | null> {
    if (this.checkImpl) return this.checkImpl()
    return { updateInfo: { version: this.remoteVersion } }
  }

  async downloadUpdate(): Promise<unknown> {
    if (this.downloadImpl) return this.downloadImpl()
    this.emit('update-downloaded', { version: this.remoteVersion })
    return ['Oscine-1.0.3.exe']
  }

  quitAndInstall(): void {
    this.installed = true
  }
}

function host(overrides: Partial<UpdateHost> & { updater?: AppUpdateDriver | null }): UpdateHost {
  return {
    isPackaged: true,
    platform: 'win32',
    appImagePath: undefined,
    currentVersion: '1.0.2',
    readPublishedVersion: async () => '1.0.3',
    ...overrides,
    updater: overrides.updater ?? null
  }
}

const logs: unknown[] = []
const originalError = console.error

afterEach(() => {
  console.error = originalError
  logs.length = 0
})

function silenceErrors(): void {
  console.error = ((...args: unknown[]) => {
    logs.push(args)
  }) as typeof console.error
}

describe('unpackaged', () => {
  it('no-ops: check does not touch the driver or the published-version reader', async () => {
    const updater = new FakeUpdater()
    const readPublishedVersion = vi.fn(async () => '9.9.9')
    const changes: string[] = []
    const service = createUpdateService(
      host({
        isPackaged: false,
        platform: 'linux',
        appImagePath: '/tmp/Oscine.AppImage',
        updater,
        readPublishedVersion
      }),
      (status) => changes.push(status.kind)
    )

    expect(service.status()).toMatchObject({
      kind: 'unsupported',
      channel: 'dev',
      currentVersion: '1.0.2',
      releasesUrl: OSCINE_RELEASES_URL
    })
    expect(updater.autoDownload).toBe(true)
    expect(await service.check()).toMatchObject({ kind: 'unsupported' })
    expect(readPublishedVersion).not.toHaveBeenCalled()
    expect(changes).toEqual([])
    await expect(service.download()).rejects.toBeInstanceOf(OscineError)
    expect(() => service.install()).toThrow(OscineError)
  })
})

describe('NSIS / AppImage', () => {
  it('configures the driver for a manual download and reports an available build', async () => {
    const updater = new FakeUpdater()
    const service = createUpdateService(host({ updater }), () => {})

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)

    const status = await service.check()
    expect(status).toMatchObject({
      kind: 'available',
      channel: 'nsis',
      availableVersion: '1.0.3'
    })
  })

  it('says up to date when the published version is not newer', async () => {
    const updater = new FakeUpdater()
    updater.remoteVersion = '1.0.2'
    const service = createUpdateService(host({ updater }), () => {})
    expect(await service.check()).toMatchObject({ kind: 'up-to-date', availableVersion: null })
  })

  it('downloads, then quitAndInstall relaunches into the new build', async () => {
    const updater = new FakeUpdater()
    const kinds: string[] = []
    const service = createUpdateService(host({ updater }), (status) => kinds.push(status.kind))

    await service.check()
    const downloaded = await service.download()
    expect(downloaded.kind).toBe('ready')
    expect(downloaded.availableVersion).toBe('1.0.3')
    service.install()
    expect(updater.installed).toBe(true)
    expect(kinds).toContain('downloading')
    expect(kinds.at(-1)).toBe('ready')
  })

  it('relays download progress from the driver', async () => {
    const updater = new FakeUpdater()
    updater.downloadImpl = async () => {
      const progress: UpdateDownloadProgress = {
        percent: 40,
        bytesPerSecond: 1000,
        transferred: 40,
        total: 100
      }
      updater.emit('download-progress', progress)
      updater.emit('update-downloaded', { version: '1.0.3' })
    }
    const percents: number[] = []
    const service = createUpdateService(host({ updater }), (status) => {
      if (status.progress) percents.push(status.progress.percent)
    })

    await service.check()
    await service.download()
    expect(percents).toContain(40)
    expect(service.status().kind).toBe('ready')
  })

  it('surfaces a driver failure as a status, not as a thrown path', async () => {
    silenceErrors()
    const updater = new FakeUpdater()
    updater.checkImpl = async () => {
      throw new Error('ENOTFOUND github.com')
    }
    const service = createUpdateService(host({ updater }), () => {})
    const status = await service.check()
    expect(status.kind).toBe('error')
    expect(status.error).toBe('Oscine could not reach the update server.')
    // The friendly headline keeps the raw reason alongside it, so a failure is
    // diagnosable from the settings panel without an on-disk log.
    expect(status.errorDetail).toBe('ENOTFOUND github.com')
  })

  it('clears the error detail once a later check succeeds', async () => {
    silenceErrors()
    const updater = new FakeUpdater()
    updater.checkImpl = async () => {
      throw new Error('ENOTFOUND github.com')
    }
    const service = createUpdateService(host({ updater }), () => {})
    expect((await service.check()).errorDetail).toBe('ENOTFOUND github.com')
    updater.checkImpl = null
    const recovered = await service.check()
    expect(recovered.kind).toBe('available')
    expect(recovered.error).toBeNull()
    expect(recovered.errorDetail).toBeNull()
  })

  it('refuses download and install when nothing is ready', async () => {
    const service = createUpdateService(host({ updater: new FakeUpdater() }), () => {})
    await expect(service.download()).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(() => service.install()).toThrow(OscineError)
  })
})

describe('deb / non-AppImage Linux', () => {
  it('offers the releases page instead of an in-app download', async () => {
    const updater = new FakeUpdater()
    const service = createUpdateService(
      host({
        platform: 'linux',
        appImagePath: undefined,
        updater,
        readPublishedVersion: async () => '1.0.4'
      }),
      () => {}
    )

    const status = await service.check()
    expect(status).toMatchObject({
      kind: 'available-external',
      channel: 'external',
      availableVersion: '1.0.4'
    })
    // A click that meant "download" is a no-op: the renderer opens the
    // releases URL, and calling download here must not throw or start a DebUpdater.
    expect(await service.download()).toMatchObject({ kind: 'available-external' })
    expect(() => service.install()).toThrow(OscineError)
    expect(updater.installed).toBe(false)
  })

  it('does not construct a self-update when the driver is omitted', async () => {
    const service = createUpdateService(
      host({
        platform: 'linux',
        updater: null,
        readPublishedVersion: async () => '1.0.2'
      }),
      () => {}
    )
    expect(await service.check()).toMatchObject({ kind: 'up-to-date', channel: 'external' })
  })

  it('does not call the driver even if one was passed', async () => {
    const updater = new FakeUpdater()
    updater.checkImpl = async () => {
      throw new Error('DebUpdater should not have been asked')
    }
    const service = createUpdateService(
      host({
        platform: 'linux',
        updater,
        readPublishedVersion: async () => '1.0.9'
      }),
      () => {}
    )
    expect(await service.check()).toMatchObject({
      kind: 'available-external',
      availableVersion: '1.0.9'
    })
  })
})
