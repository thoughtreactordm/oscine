import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_SCRIPT_NAME,
  bridgeLaunchFor,
  resolveBridgeLaunch,
  type BridgeFs,
  type BridgeLayout
} from '../../../src/main/mcp/bridgeLaunch'

/**
 * Where the stdio bridge is and what starts it — **W24-10**. Paths are built
 * with the host's `node:path`, so these assert through `join` rather than
 * against literal separators; the Windows CI leg checks the other form.
 */
const REPO = resolve(__dirname, '../../..')

const layout = (patch: Partial<BridgeLayout> = {}): BridgeLayout => ({
  isPackaged: true,
  execPath: join('opt', 'Oscine', 'oscine'),
  resourcesPath: join('opt', 'Oscine', 'resources'),
  appRoot: join('opt', 'Oscine', 'resources', 'app.asar'),
  stableDir: join('home', 'me', '.config', 'Oscine', 'mcp'),
  ...patch
})

function memoryFs(files: Record<string, string>): BridgeFs & { files: Map<string, Buffer> } {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]))
  return {
    files: map,
    exists: (path) => map.has(path),
    read: (path) => {
      const value = map.get(path)
      if (!value) throw new Error(`ENOENT ${path}`)
      return value
    },
    copy: (from, to) => map.set(to, Buffer.from(map.get(from) ?? '')),
    mkdir: vi.fn()
  }
}

describe('bridge launch', () => {
  it('runs the packaged script from resources with the app binary', () => {
    expect(bridgeLaunchFor(layout())).toEqual({
      command: join('opt', 'Oscine', 'oscine'),
      args: [join('opt', 'Oscine', 'resources', 'mcp', BRIDGE_SCRIPT_NAME)]
    })
  })

  it('runs the repository script in dev', () => {
    const dev = layout({ isPackaged: false, appRoot: REPO, execPath: 'electron' })
    expect(bridgeLaunchFor(dev).args).toEqual([join(REPO, 'resources', 'mcp', BRIDGE_SCRIPT_NAME)])
  })

  it('names the AppImage itself and a stable copy, never the per-launch mount', () => {
    const appImage = join('home', 'me', 'Apps', 'Oscine.AppImage')
    const mounted = layout({
      execPath: join('tmp', '.mount_OscineX', 'oscine'),
      resourcesPath: join('tmp', '.mount_OscineX', 'resources'),
      appImage
    })
    const shipped = join('tmp', '.mount_OscineX', 'resources', 'mcp', BRIDGE_SCRIPT_NAME)
    const stable = join('home', 'me', '.config', 'Oscine', 'mcp', BRIDGE_SCRIPT_NAME)
    const fs = memoryFs({ [shipped]: 'v2' })

    expect(resolveBridgeLaunch(mounted, fs)).toEqual({ command: appImage, args: [stable] })
    expect(fs.files.get(stable)?.toString()).toBe('v2')

    // An update replaces the copy; an unchanged one is left alone.
    fs.files.set(shipped, Buffer.from('v3'))
    const copy = vi.spyOn(fs, 'copy')
    resolveBridgeLaunch(mounted, fs)
    expect(fs.files.get(stable)?.toString()).toBe('v3')
    resolveBridgeLaunch(mounted, fs)
    expect(copy).toHaveBeenCalledTimes(1)
  })

  it('is null when this install has no bridge script', () => {
    expect(resolveBridgeLaunch(layout(), memoryFs({}))).toBeNull()
  })

  it('finds the real script in the repository', () => {
    expect(
      resolveBridgeLaunch(layout({ isPackaged: false, appRoot: REPO, execPath: 'electron' }))
    ).not.toBeNull()
  })

  it('is packaged on both platforms', () => {
    const config = readFileSync(join(REPO, 'electron-builder.yml'), 'utf8')
    for (const platform of ['win', 'linux']) {
      // The platform's top-level block: from its key to the next top-level key.
      const block = new RegExp(`^${platform}:\\n((?:[ #].*\\n|\\n)*)`, 'm').exec(config)?.[1]
      expect(block, platform).toContain('from: resources/mcp')
      expect(block, platform).toContain(BRIDGE_SCRIPT_NAME)
    }
  })
})
