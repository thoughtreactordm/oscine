import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { CdToc } from '../../../src/shared/cdrip'
import type { CdDrive, CdSectorRead } from '../../../src/main/cdrip/drive'
import lbaFixture from './fixtures/captured-lba.json'
import msfFixture from './fixtures/captured-msf.json'
import mixedFixture from './fixtures/mixed-mode.json'

const addon = createRequire(import.meta.url)('@oscine/cdrip') as CdDrive & {
  _test: (operation: string, ...args: unknown[]) => any
}
const native = addon._test
const toc = Buffer.from(lbaFixture.hex, 'hex')
const mixed = Buffer.from(mixedFixture.hex, 'hex')
// Captured GET CONFIGURATION CD Read feature: C2 + CD-TEXT, current, v2.
const capabilities = Buffer.from('0000000c00000008001e090403000000', 'hex')
const withoutC2 = Buffer.from('0000000c00000008001e090401000000', 'hex')
function read(start: number, count: number, steps: (Buffer | string)[]) {
  return native('readScript', start, count, steps) as {
    audio?: CdSectorRead
    error?: Error & { code: string; sector?: number }
    commands: Buffer[]
  }
}
function sector(value: number, flagged = false) {
  const b = Buffer.alloc(2352 + 294)
  b.fill(value, 0, 2352)
  if (flagged) b[2352] = 1
  return b
}

describe('native MMC protocol (actual C++ with a scripted transport)', () => {
  it('builds exact TOC and READ CD commands, with a three-byte transfer count', () => {
    expect(native('tocCdb', 804, false).toString('hex')).toBe('43000000000000032400')
    expect(native('tocCdb', 804, true)[1]).toBe(2)
    expect(native('readCdb', 0x123456, 450, true).toString('hex')).toBe('be04001234560001c2120000')
    expect(native('readCdb', 0, 1, false)[9]).toBe(0x10)
    expect(() => native('readCdb', 0, 0, false)).toThrow()
    expect(() => native('readCdb', 0, 451, false)).toThrow()
    expect(() => native('readCdb', 0x7fffffff, 1, false)).toThrow()
  })

  it('parses the captured seven-track TOC identically in LBA and MSF', () => {
    const parsed = native('parseToc', toc, false) as CdToc
    expect(native('parseToc', Buffer.from(msfFixture.hex, 'hex'), true)).toEqual(parsed)
    expect(parsed).toMatchObject({ firstTrack: 1, lastTrack: 7, leadOutSector: 169995 })
    expect(parsed.entries.map((e) => e.startSector)).toEqual([
      33, 27635, 49555, 72600, 90635, 116295, 149488
    ])
    expect(parsed.entries.map((e) => e.sectorCount)).toEqual([
      27602, 21920, 23045, 18035, 25660, 33193, 20507
    ])
    expect(parsed.entries.every((e) => e.isAudio && !e.preEmphasis)).toBe(true)
  })

  it('preserves trailing data and audio pre-emphasis flags', () => {
    expect(native('parseToc', mixed, false)).toEqual({
      firstTrack: 1,
      lastTrack: 3,
      leadOutSector: 30000,
      entries: [
        { number: 1, startSector: 0, sectorCount: 10000, isAudio: true, preEmphasis: true },
        { number: 2, startSector: 10000, sectorCount: 10000, isAudio: true, preEmphasis: false },
        { number: 3, startSector: 20000, sectorCount: 10000, isAudio: false, preEmphasis: false }
      ]
    })
  })

  it('handles the MSF bias and rejects malformed addresses', () => {
    expect(native('msfToLba', 0, 2, 0)).toBe(0)
    expect(native('msfToLba', 0, 0, 0)).toBe(-150)
    expect(native('msfToLba', 1, 0, 0)).toBe(4350)
    expect(() => native('msfToLba', 0, 60, 0)).toThrow()
    expect(() => native('msfToLba', 0, 2, 75)).toThrow()
  })

  it('rejects truncated, unordered, missing lead-out, and overflowing TOCs', () => {
    for (let size = 0; size < toc.length; size++) {
      expect(() => native('parseToc', toc.subarray(0, size), false)).toThrow()
    }
    for (const [offset, value] of [
      [2, 0],
      [3, 100],
      [6, 9],
      [62, 7],
      [5, 0],
      [8, 0xff]
    ]) {
      const broken = Buffer.from(toc)
      broken[offset] = value
      expect(() => native('parseToc', broken, false)).toThrow()
    }
    const unordered = Buffer.from(toc)
    unordered.writeUInt32BE(1, 16)
    expect(() => native('parseToc', unordered, false)).toThrow()
  })

  it.each([
    [2, 0x3a, 'no-disc'],
    [2, 4, 'device-busy'],
    [6, 0x28, 'device-busy'],
    [5, 0x64, 'not-audio'],
    [5, 0x20, 'unsupported-drive'],
    [5, 0x24, 'unsupported-drive'],
    [3, 0x11, 'read-failed'],
    [4, 0x44, 'read-failed']
  ])('maps fixed and descriptor sense key %s ASC %s to %s', (key, asc, code) => {
    const fixed = Buffer.alloc(18)
    fixed[0] = 0x70
    fixed[2] = Number(key)
    fixed[7] = 10
    fixed[12] = Number(asc)
    expect(native('senseCode', fixed, 2)).toBe(code)
    expect(native('senseCode', Buffer.from([0x72, Number(key), Number(asc), 0]), 2)).toBe(code)
  })

  it('maps busy status and rejects incomplete sense data conservatively', () => {
    expect(native('senseCode', Buffer.alloc(0), 8)).toBe('device-busy')
    expect(native('senseCode', Buffer.from([0x70, 0, 2]), 2)).toBe('read-failed')
  })

  it('deinterleaves C2 without byte-swapping the PCM', () => {
    const raw = Buffer.concat([sector(0x12), sector(0x34)])
    raw[0] = 0x78
    raw[1] = 0x56
    const result = read(33, 2, [toc, capabilities, raw])
    expect(result.error).toBeUndefined()
    expect(result.audio?.pcm.length).toBe(4704)
    expect(result.audio?.pcm.readInt16LE(0)).toBe(0x5678)
    expect(result.audio?.pcm[2352]).toBe(0x34)
    expect(result.audio?.c2).toEqual(Buffer.alloc(588))
    expect(result.commands[2][9]).toBe(0x12)
  })

  it('returns null C2 when absent or when firmware rejects advertised C2', () => {
    const plain = Buffer.alloc(2352, 0x42)
    expect(read(33, 1, [toc, withoutC2, plain]).audio).toEqual({ pcm: plain, c2: null })
    expect(read(33, 1, [toc, 'unsupported-drive', plain]).audio?.c2).toBeNull()
    const result = read(33, 1, [toc, capabilities, 'unsupported-drive', plain])
    expect(result.audio).toEqual({ pcm: plain, c2: null })
    expect(result.commands.slice(2).map((c) => c[9])).toEqual([0x12, 0x10])
  })

  it('retries C2-flagged sectors and keeps the corrected data', () => {
    const result = read(33, 2, [
      toc,
      capabilities,
      Buffer.concat([sector(1), sector(2, true)]),
      sector(3),
      sector(4, true),
      sector(5)
    ])
    expect(result.error).toBeUndefined()
    expect(result.audio?.pcm).toEqual(Buffer.concat([Buffer.alloc(2352, 3), Buffer.alloc(2352, 5)]))
    expect(result.commands.slice(3).map((c) => c.readUInt32BE(2))).toEqual([33, 34, 34])
  })

  it('bounds retries and reports the precise failed sector', () => {
    const result = read(33, 2, [
      toc,
      withoutC2,
      'read-failed',
      Buffer.alloc(2352),
      ...Array(4).fill('read-failed')
    ])
    expect(result.error).toMatchObject({ code: 'read-failed', sector: 34 })
    expect(result.error?.message).toContain('sector 34')
    expect(result.commands.length).toBe(8)
  })

  it('treats short transfers as failures and never returns zero-padded audio', () => {
    const result = read(33, 1, [
      toc,
      withoutC2,
      ...Array.from({ length: 5 }, () => Buffer.alloc(2351))
    ])
    expect(result.error).toMatchObject({ code: 'read-failed', sector: 33 })
    expect(result.audio).toBeUndefined()
  })

  it('does not retry a media change, empty drive, or unsupported READ CD', () => {
    for (const code of ['device-busy', 'no-disc', 'unsupported-drive']) {
      const result = read(33, 1, [toc, withoutC2, code])
      expect(result.error?.code).toBe(code)
      expect(result.commands.length).toBe(3)
    }
  })

  it('rejects data tracks, data crossings, and lead-out before issuing READ CD', () => {
    for (const [start, count] of [
      [20000, 1],
      [19999, 2],
      [30000, 1]
    ]) {
      const result = read(start, count, [mixed])
      expect(result.error?.code).toBe('not-audio')
      expect(result.commands.map((c) => c[0])).toEqual([0x43])
    }
  })

  it('chunks reads to sixteen sectors and allows adjacent audio tracks', () => {
    const result = read(9999, 17, [
      mixed,
      withoutC2,
      Buffer.alloc(2352 * 16, 1),
      Buffer.alloc(2352, 2)
    ])
    expect(result.audio?.pcm.length).toBe(2352 * 17)
    expect(result.commands.slice(2).map((c) => [c.readUInt32BE(2), c[8]])).toEqual([
      [9999, 16],
      [10015, 1]
    ])
  })

  it('rejects invalid arguments before touching hardware and rejects unknown drive IDs asynchronously', async () => {
    expect(() => addon.readSectors('fake', 0, 451)).toThrow(RangeError)
    expect(() => addon.readSectors('fake', 0.5, 1)).toThrow(RangeError)
    expect(() => addon.readToc('bad\0id')).toThrow(TypeError)
    const promise = addon.readToc('not-an-optical-drive')
    expect(promise).toBeInstanceOf(Promise)
    await expect(promise).rejects.toMatchObject({ code: 'unsupported-drive' })
  })
})
