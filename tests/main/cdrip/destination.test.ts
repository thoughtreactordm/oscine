import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RipDestinationProbe } from '@shared/cdrip'
import { validateRipDestination } from '../../../src/main/cdrip/destination'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rip-dest-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function root(id: number, folder: string) {
  return { id, path: folder }
}

function probeOver(base: Partial<RipDestinationProbe>): RipDestinationProbe {
  return {
    isDirectory: () => true,
    isWritable: () => true,
    deviceId: () => 1,
    ...base
  }
}

describe('validateRipDestination', () => {
  it('resolves a folder inside a root and returns a POSIX-relative dir', () => {
    const library = join(dir, 'Music')
    const dest = join(library, 'Incoming')
    const nested = join(dest, 'Deep')
    mkdirSync(nested, { recursive: true })

    expect(validateRipDestination(dest, [root(7, library)])).toEqual({
      ok: true,
      rootId: 7,
      relDir: 'Incoming'
    })
    expect(validateRipDestination(nested, [root(7, library)])).toEqual({
      ok: true,
      rootId: 7,
      relDir: 'Incoming/Deep'
    })
  })

  it('accepts the root itself with an empty relDir', () => {
    const library = join(dir, 'Music')
    mkdirSync(library)

    expect(validateRipDestination(library, [root(1, library)])).toEqual({
      ok: true,
      rootId: 1,
      relDir: ''
    })
  })

  it('refuses a folder that is not under any root', () => {
    const library = join(dir, 'Music')
    const other = join(dir, 'Downloads')
    mkdirSync(library)
    mkdirSync(other)

    expect(validateRipDestination(other, [root(1, library)])).toEqual({
      ok: false,
      reason: 'outside-roots'
    })
  })

  it('refuses a folder that is a parent of a root rather than a child', () => {
    const library = join(dir, 'Music')
    mkdirSync(library)

    expect(validateRipDestination(dir, [root(1, library)])).toEqual({
      ok: false,
      reason: 'outside-roots'
    })
  })

  it('refuses a relative path', () => {
    expect(validateRipDestination('Music', [root(1, join(dir, 'Music'))])).toEqual({
      ok: false,
      reason: 'outside-roots'
    })
  })

  it('reports not-writable when the folder does not exist', () => {
    const library = join(dir, 'Music')
    mkdirSync(library)

    expect(validateRipDestination(join(library, 'Missing'), [root(1, library)])).toEqual({
      ok: false,
      reason: 'not-writable'
    })
  })

  it('reports not-writable when the path is a file', () => {
    const library = join(dir, 'Music')
    mkdirSync(library)
    const file = join(library, 'readme.txt')
    writeFileSync(file, 'nope')

    expect(validateRipDestination(file, [root(1, library)])).toEqual({
      ok: false,
      reason: 'not-writable'
    })
  })

  it('reports not-writable when the directory cannot be written', () => {
    const library = join(dir, 'Music')
    const dest = join(library, 'Locked')
    mkdirSync(dest, { recursive: true })

    expect(
      validateRipDestination(dest, [root(1, library)], probeOver({ isWritable: () => false }))
    ).toEqual({ ok: false, reason: 'not-writable' })
  })

  it('reports cross-device when the destination is on another volume from the root', () => {
    const library = join(dir, 'Music')
    const dest = join(library, 'Incoming')
    mkdirSync(dest, { recursive: true })

    expect(
      validateRipDestination(
        dest,
        [root(1, library)],
        probeOver({
          deviceId: (absPath) => (absPath === dest ? 2 : 1)
        })
      )
    ).toEqual({ ok: false, reason: 'cross-device' })
  })
})
