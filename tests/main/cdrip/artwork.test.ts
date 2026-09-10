import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RipArtworkPicker } from '../../../src/main/cdrip/artwork'
import { MAX_ARTWORK_INGEST_BYTES } from '@shared/artwork'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rip-art-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const path = join(dir, 'cover.jpg')
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1])
  writeFileSync(path, bytes)
  const pick = vi.fn<() => Promise<string | null>>(async () => path)
  const store = vi.fn(async () => ({ hash: 'a'.repeat(64), generated: true }))
  const picker = new RipArtworkPicker(pick, { store, has: async () => true })
  return { path, bytes, pick, store, picker }
}

describe('rip artwork picker', () => {
  it('keeps the original bytes and protects its preview from cache pruning', async () => {
    const { picker, bytes } = harness()
    const chosen = await picker.pick()
    expect(picker.resolve(chosen!.hash!)).toEqual({ bytes, mime: 'image/jpeg' })
    expect(picker.referencedHashes()).toEqual([chosen!.hash])
    expect(() => picker.resolve('b'.repeat(64))).toThrow(/Choose the album art again/)
  })

  it('keeps the previous cover when the dialog is cancelled or decoding fails', async () => {
    const { picker, pick, store } = harness()
    const chosen = await picker.pick()
    pick.mockResolvedValueOnce(null)
    expect(await picker.pick()).toBeNull()
    store.mockRejectedValueOnce(new Error('decode failed'))
    await expect(picker.pick()).rejects.toThrow('decode failed')
    expect(picker.referencedHashes()).toEqual([chosen!.hash])
  })

  it('rejects unsupported or oversized images before decoding', async () => {
    const { picker, path, store } = harness()
    writeFileSync(path, 'not an image')
    await expect(picker.pick()).rejects.toThrow(/JPEG or PNG/)
    writeFileSync(path, Buffer.alloc(MAX_ARTWORK_INGEST_BYTES + 1))
    await expect(picker.pick()).rejects.toThrow(/too large/)
    expect(store).not.toHaveBeenCalled()
  })

  it('returns a readable error without exposing the selected filesystem path', async () => {
    const { picker, pick } = harness()
    pick.mockResolvedValueOnce(join(dir, 'gone.jpg'))
    await expect(picker.pick()).rejects.toMatchObject({ message: 'That image could not be read.' })
  })
})
