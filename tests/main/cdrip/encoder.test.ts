import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFile } from 'music-metadata'
import {
  createFlacEncoder,
  EncoderError,
  resolveFlacBinaryPath
} from '../../../src/main/cdrip/encoder'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const fixture = join(here, 'fixtures', 'fake-flac.mjs')
const bundled = resolveFlacBinaryPath({
  isPackaged: false,
  resourcesPath: '',
  appRoot: repoRoot
})
const hasFlac = existsSync(bundled) ? it : it.skip

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-flac-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function encoder(mode: string) {
  return createFlacEncoder({
    binaryPath: process.execPath,
    spawn: (_cmd, args, opts) =>
      spawn(process.execPath, [fixture, ...args], {
        ...opts,
        env: { ...opts?.env, FAKE_FLAC_MODE: mode }
      })
  })
}

function tone(seconds: number, hz = 440): Buffer {
  const frames = 44100 * seconds
  const pcm = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * hz * i) / 44100) * 16000)
    pcm.writeInt16LE(sample, i * 4)
    pcm.writeInt16LE(sample, i * 4 + 2)
  }
  return pcm
}

describe('resolveFlacBinaryPath', () => {
  it('returns the packaged extraResources layout on both platforms', () => {
    expect(
      resolveFlacBinaryPath({
        isPackaged: true,
        resourcesPath: '/opt/Oscine/resources',
        appRoot: '/opt/Oscine/resources/app.asar',
        platform: 'linux',
        arch: 'x64'
      })
    ).toBe(join('/opt/Oscine/resources', 'bin', 'flac'))
    expect(
      resolveFlacBinaryPath({
        isPackaged: true,
        resourcesPath: 'C:/Program Files/Oscine/resources',
        appRoot: 'C:/Program Files/Oscine/resources/app.asar',
        platform: 'win32',
        arch: 'x64'
      })
    ).toBe(join('C:/Program Files/Oscine/resources', 'bin', 'flac.exe'))
  })

  it('returns the repo-relative layout in development', () => {
    expect(
      resolveFlacBinaryPath({
        isPackaged: false,
        resourcesPath: '/unused',
        appRoot: '/src/oscine',
        platform: 'linux',
        arch: 'x64'
      })
    ).toBe(join('/src/oscine', 'resources', 'bin', 'linux-x64', 'flac'))
    expect(
      resolveFlacBinaryPath({
        isPackaged: false,
        resourcesPath: '/unused',
        appRoot: '/src/oscine',
        platform: 'win32',
        arch: 'x64'
      })
    ).toBe(join('/src/oscine', 'resources', 'bin', 'win32-x64', 'flac.exe'))
  })
})

describe('createFlacEncoder', () => {
  it('declares the flac extension and rejects a compression level outside 0–8', () => {
    expect(encoder('ok').ext).toBe('flac')
    expect(() => createFlacEncoder({ binaryPath: 'flac', compressionLevel: 9 })).toThrow(RangeError)
  })

  it('surfaces encoder stderr on a non-zero exit and deletes the partial file', async () => {
    const dest = join(dir, 'track.flac')
    await expect(
      encoder('fail').encode(Readable.from(tone(1)), dest, { aborted: false })
    ).rejects.toMatchObject({
      name: 'EncoderError',
      code: 'nonzero-exit',
      message: expect.stringContaining('encoder exploded: bad pcm')
    })
    expect(existsSync(dest)).toBe(false)
  })

  it('treats a silent empty output as a stderr diagnostic and leaves no file', async () => {
    const dest = join(dir, 'track.flac')
    await expect(
      encoder('none').encode(Readable.from(tone(1)), dest, { aborted: false })
    ).rejects.toMatchObject({
      code: 'stderr',
      message: expect.stringContaining('nothing to write')
    })
    expect(existsSync(dest)).toBe(false)
  })

  it('reports a broken pipe when the encoder closes stdin early', async () => {
    const dest = join(dir, 'track.flac')
    const pcm = new Readable({
      read() {
        this.push(Buffer.alloc(65536))
      }
    })
    await expect(encoder('pipe').encode(pcm, dest, { aborted: false })).rejects.toMatchObject({
      code: 'broken-pipe'
    })
    expect(existsSync(dest)).toBe(false)
  })

  it('a cancelled encode leaves no file behind', async () => {
    const dest = join(dir, 'track.flac')
    const signal = { aborted: false }
    const pending = encoder('hang').encode(Readable.from(tone(1)), dest, signal)
    const start = Date.now()
    while (!existsSync(dest) && Date.now() - start < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(existsSync(dest)).toBe(true)
    signal.aborted = true
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses to start when the signal is already aborted', async () => {
    const dest = join(dir, 'track.flac')
    await expect(
      encoder('ok').encode(Readable.from(tone(1)), dest, { aborted: true })
    ).rejects.toBeInstanceOf(EncoderError)
    expect(existsSync(dest)).toBe(false)
  })
})

describe('FLAC round-trip (needs vendored encoder)', () => {
  hasFlac('encodes synthesised PCM that decodes back to the same samples', async () => {
    const pcm = tone(2)
    const dest = join(dir, 'tone.flac')
    await createFlacEncoder({ binaryPath: bundled }).encode(Readable.from(pcm), dest, {
      aborted: false
    })
    const meta = await parseFile(dest)
    expect(meta.format.container).toMatch(/flac/i)
    expect(meta.format.duration).toBeCloseTo(2, 2)
    expect(meta.format.numberOfChannels).toBe(2)
    expect(meta.format.sampleRate).toBe(44100)
    expect(await decodeRaw(bundled, dest)).toEqual(pcm)
  })
})

function decodeRaw(binaryPath: string, dest: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const child = spawn(
      binaryPath,
      ['-d', '--silent', '--force-raw-format', '--endian=little', '--sign=signed', '-c', dest],
      { env: { ...process.env, LD_LIBRARY_PATH: dirname(binaryPath) } }
    )
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`flac -d exited ${code}`))
    })
  })
}
