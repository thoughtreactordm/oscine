import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  detectUpdateChannel,
  latestMetadataName,
  latestMetadataUrl,
  OSCINE_RELEASES_URL,
  parseLatestYmlVersion,
  updateChannelCanSelfUpdate
} from '../../src/shared/update'

describe('detectUpdateChannel', () => {
  it('is dev when unpackaged, even on a Linux machine that happens to have APPIMAGE set', () => {
    expect(
      detectUpdateChannel({
        isPackaged: false,
        platform: 'linux',
        appImagePath: '/tmp/Oscine.AppImage'
      })
    ).toBe('dev')
  })

  it('is nsis on packaged Windows', () => {
    expect(
      detectUpdateChannel({ isPackaged: true, platform: 'win32', appImagePath: undefined })
    ).toBe('nsis')
  })

  it('is appimage only when the APPIMAGE path is present', () => {
    expect(
      detectUpdateChannel({
        isPackaged: true,
        platform: 'linux',
        appImagePath: '/opt/Oscine.AppImage'
      })
    ).toBe('appimage')
    expect(
      detectUpdateChannel({ isPackaged: true, platform: 'linux', appImagePath: undefined })
    ).toBe('external')
    expect(detectUpdateChannel({ isPackaged: true, platform: 'linux', appImagePath: '' })).toBe(
      'external'
    )
  })

  it('treats any other packaged platform as external rather than guessing at a self-update', () => {
    expect(
      detectUpdateChannel({ isPackaged: true, platform: 'darwin', appImagePath: undefined })
    ).toBe('external')
  })
})

describe('updateChannelCanSelfUpdate', () => {
  it('is only the two installers electron-updater actually swaps in-process', () => {
    expect(updateChannelCanSelfUpdate('nsis')).toBe(true)
    expect(updateChannelCanSelfUpdate('appimage')).toBe(true)
    expect(updateChannelCanSelfUpdate('external')).toBe(false)
    expect(updateChannelCanSelfUpdate('dev')).toBe(false)
  })
})

describe('latest metadata', () => {
  it('names the sidecar electron-updater will fetch per platform', () => {
    expect(latestMetadataName('win32')).toBe('latest.yml')
    expect(latestMetadataName('linux')).toBe('latest-linux.yml')
    expect(latestMetadataUrl('win32')).toBe(`${OSCINE_RELEASES_URL}/latest/download/latest.yml`)
  })
})

describe('parseLatestYmlVersion', () => {
  it('reads quoted and unquoted version fields', () => {
    expect(parseLatestYmlVersion('version: 1.0.3\npath: Oscine-1.0.3.AppImage\n')).toBe('1.0.3')
    expect(parseLatestYmlVersion('version: "1.0.3"\n')).toBe('1.0.3')
    expect(parseLatestYmlVersion("version: '1.0.3'\n")).toBe('1.0.3')
  })

  it('strips a BOM and ignores a missing field', () => {
    expect(parseLatestYmlVersion('\uFEFFversion: 2.0.0\n')).toBe('2.0.0')
    expect(parseLatestYmlVersion('path: Oscine-1.0.3.AppImage\n')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.3', '1.0.2')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.2', '1.0.2')).toBe(0)
  })

  it('sorts a prerelease behind the matching release', () => {
    expect(compareVersions('1.0.0-rc', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBe(0)
  })
})
