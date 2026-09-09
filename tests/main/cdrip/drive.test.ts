import { describe, expect, it, vi } from 'vitest'
import { CdDriveError, createCdDrive, type CdDrive } from '../../../src/main/cdrip/drive'

function fake(): CdDrive {
  return {
    listDrives: vi.fn(async () => [
      { id: 'disc:fake', label: 'Fake CD', vendor: 'Test', product: 'Disc' }
    ]),
    readToc: vi.fn(async () => ({
      firstTrack: 1,
      lastTrack: 1,
      leadOutSector: 75,
      entries: [{ number: 1, startSector: 0, sectorCount: 75, isAudio: true, preEmphasis: false }]
    })),
    readSectors: vi.fn(async (_id, _start, count) => ({
      pcm: Buffer.alloc(count * 2352),
      c2: null
    }))
  }
}
describe('CD drive interface', () => {
  it('loads the real addon through the default main-process loader', async () => {
    await expect(createCdDrive().readToc('invalid-drive-id')).rejects.toMatchObject({
      code: 'unsupported-drive',
      message: 'Invalid optical drive ID'
    })
  })

  it('loads lazily once and lets consumers use a fake without hardware', async () => {
    const native = fake(),
      load = vi.fn(() => native)
    const drive = createCdDrive(load)
    expect(load).not.toHaveBeenCalled()
    const [disc] = await drive.listDrives()
    const toc = await drive.readToc(disc.id)
    const audio = await drive.readSectors(disc.id, toc.entries[0].startSector, 2)
    expect(audio.pcm.length).toBe(4704)
    expect(audio.c2).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    expect(native.readSectors).toHaveBeenCalledWith('disc:fake', 0, 2)
  })
  it('preserves native error code, failed sector and cause', async () => {
    const native = fake()
    const cause = Object.assign(new Error('Bad sector'), { code: 'read-failed', sector: 42 })
    native.readSectors = vi.fn().mockRejectedValue(cause)
    await expect(createCdDrive(() => native).readSectors('fake', 42, 1)).rejects.toMatchObject({
      name: 'CdDriveError',
      code: 'read-failed',
      sector: 42,
      cause
    })
  })
  it('normalizes loader failures, sync validation and unknown errors to rejected promises', async () => {
    const cause = new Error('Missing binary')
    const drive = createCdDrive(() => {
      throw cause
    })
    await expect(drive.listDrives()).rejects.toBeInstanceOf(CdDriveError)
    await expect(drive.listDrives()).rejects.toMatchObject({ code: 'read-failed', cause })
    const native = fake()
    native.readToc = () => {
      throw new TypeError('Bad ID')
    }
    await expect(createCdDrive(() => native).readToc('')).rejects.toMatchObject({
      code: 'read-failed'
    })
  })
})
