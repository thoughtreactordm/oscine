import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NoctaliaSync,
  noctaliaConfigDir,
  noctaliaPalettePath
} from '../../../src/main/theme/noctalia'
import { NOCTALIA_ROLES, type NoctaliaColors, type NoctaliaStatus } from '../../../src/shared/theme'

function colors(fill: string): NoctaliaColors {
  return Object.fromEntries(NOCTALIA_ROLES.map((role) => [role, fill])) as NoctaliaColors
}

function paletteJson(dark: string): string {
  return JSON.stringify({ version: 1, light: colors('#eeeeee'), dark: colors(dark) })
}

let root: string
let path: string
let enabled: boolean
let seen: NoctaliaStatus[]
let sync: NoctaliaSync

function make(platform: NodeJS.Platform = 'linux'): NoctaliaSync {
  return new NoctaliaSync({
    enabled: () => enabled,
    palettePath: path,
    platform,
    settleMs: 20,
    onChanged: (status) => seen.push(status)
  })
}

/** Until the watcher has delivered a status matching `done`. */
async function until(done: (status: NoctaliaStatus) => boolean): Promise<NoctaliaStatus> {
  for (let i = 0; i < 100; i += 1) {
    if (done(sync.status())) return sync.status()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out at ${JSON.stringify(sync.status())}`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oscine-noctalia-sync-'))
  path = join(root, 'oscine', 'noctalia-palette.json')
  enabled = true
  seen = []
  sync = make()
})

afterEach(() => {
  sync.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('NoctaliaSync', () => {
  it('is disabled until the colour source is Noctalia', () => {
    enabled = false
    sync.sync()
    expect(sync.status().state).toBe('disabled')
    expect(sync.palette()).toBeNull()
  })

  it('is unsupported off Linux, whatever the setting says', () => {
    sync = make('win32')
    sync.sync()
    expect(sync.status().state).toBe('unsupported')
    expect(() => sync.setup('auto')).toThrow('Linux')
  })

  it('waits for a palette that has not been generated, then picks it up', async () => {
    sync.sync()
    expect(sync.status().state).toBe('waiting')

    writeFileSync(path, paletteJson('#111111'))
    const status = await until((s) => s.state === 'synced')
    expect(status.palette?.dark.surface).toBe('#111111')
  })

  it('follows an atomic replace', async () => {
    sync.sync()
    writeFileSync(path, paletteJson('#111111'))
    await until((s) => s.palette?.dark.surface === '#111111')

    const temp = `${path}.tmp`
    writeFileSync(temp, paletteJson('#222222'))
    renameSync(temp, path)
    await until((s) => s.palette?.dark.surface === '#222222')
  })

  it('keeps the last valid palette through a bad write, and says so without a path', async () => {
    sync.sync()
    writeFileSync(path, paletteJson('#111111'))
    await until((s) => s.state === 'synced')

    writeFileSync(path, '{ not json')
    const status = await until((s) => s.state === 'error')
    expect(status.palette?.dark.surface).toBe('#111111')
    expect(status.message).not.toContain(root)
  })

  it('drops the palette and stops watching when switched off', async () => {
    sync.sync()
    writeFileSync(path, paletteJson('#111111'))
    await until((s) => s.state === 'synced')

    enabled = false
    sync.sync()
    expect(sync.status()).toEqual({ state: 'disabled', palette: null, message: '' })

    writeFileSync(path, paletteJson('#222222'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(sync.palette()).toBeNull()
  })

  it('only reports a status that changed', () => {
    enabled = false
    sync.sync()
    sync.sync()
    expect(seen).toEqual([])
  })
})

describe('paths', () => {
  const home = '/home/someone'

  it('keeps the palette under XDG state, shared by dev and packaged builds', () => {
    expect(noctaliaPalettePath({}, home)).toBe(
      join(home, '.local', 'state', 'oscine', 'noctalia-palette.json')
    )
    expect(noctaliaPalettePath({ XDG_STATE_HOME: '/state' }, home)).toBe(
      join('/state', 'oscine', 'noctalia-palette.json')
    )
  })

  it('honours each version’s own config override', () => {
    const env = { NOCTALIA_CONFIG_DIR: '/legacy', NOCTALIA_CONFIG_HOME: '/modern' }
    expect(noctaliaConfigDir('v4', env, home)).toBe('/legacy')
    expect(noctaliaConfigDir('v5', env, home)).toBe('/modern')
    expect(() => noctaliaConfigDir('auto', env, home)).toThrow('Choose')
    expect(noctaliaConfigDir('auto', {}, home)).toBe(join(home, '.config', 'noctalia'))
  })
})
