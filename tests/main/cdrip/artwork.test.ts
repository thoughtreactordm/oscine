import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RipArtworkPicker } from '../../../src/main/cdrip/artwork'
import type { CoverArtArchiveClient } from '../../../src/main/artwork/coverArtArchive'
import { MAX_ARTWORK_INGEST_BYTES, type CoverArtCandidate } from '@shared/artwork'
import { netFailed, netOk, type NetResult } from '@shared/net'

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

const MBID = '11111111-1111-4111-8111-111111111111'

function candidate(front: boolean, fullUrl: string): CoverArtCandidate {
  return { source: 'coverartarchive', front, thumbUrl: `${fullUrl}/thumb`, fullUrl }
}

function coverArt(overrides: {
  front?: NetResult<CoverArtCandidate[]>
  bytes?: NetResult<Uint8Array>
}): CoverArtArchiveClient {
  return {
    releaseFront: vi.fn(async () => overrides.front ?? netOk([])),
    releaseGroupFront: vi.fn(async () => netOk<CoverArtCandidate[]>([])),
    fetchImageBytes: vi.fn(async () => overrides.bytes ?? netOk(Buffer.from([0xff, 0xd8, 0xff, 1])))
  }
}

describe('rip artwork proposal from a matched release', () => {
  it('drops a release front through the identical validate-and-store path', async () => {
    const { picker, store } = harness()
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 1])
    const client = coverArt({
      front: netOk([candidate(false, 'back'), candidate(true, 'front')]),
      bytes: netOk(bytes)
    })
    const ref = await picker.proposeFromRelease(client, MBID)
    expect(ref).toEqual({ present: true, hash: 'a'.repeat(64), mime: 'image/jpeg' })
    // The bytes fetched were the front candidate's, and the slot is the one the
    // file picker fills — resolvable and protected from cache pruning.
    expect(client.fetchImageBytes).toHaveBeenCalledWith('front')
    expect(picker.resolve(ref!.hash!)).toEqual({ bytes, mime: 'image/jpeg' })
    expect(picker.referencedHashes()).toEqual([ref!.hash])
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('proposes nothing for a release with no front cover, leaving any pick intact', async () => {
    const { picker } = harness()
    const chosen = await picker.pick()
    // A manifest with only non-front images, and an empty (404 → empty) manifest.
    expect(
      await picker.proposeFromRelease(coverArt({ front: netOk([candidate(false, 'x')]) }), MBID)
    ).toBeNull()
    expect(await picker.proposeFromRelease(coverArt({ front: netOk([]) }), MBID)).toBeNull()
    expect(picker.referencedHashes()).toEqual([chosen!.hash])
  })

  it('proposes nothing when the manifest or image fetch fails', async () => {
    const { picker, store } = harness()
    store.mockClear()
    const offline = netFailed<CoverArtCandidate[]>({ kind: 'unavailable', message: 'offline' })
    expect(await picker.proposeFromRelease(coverArt({ front: offline }), MBID)).toBeNull()
    const imageGone = netFailed<Uint8Array>({ kind: 'not-found', message: 'gone' })
    const client = coverArt({ front: netOk([candidate(true, 'front')]), bytes: imageGone })
    expect(await picker.proposeFromRelease(client, MBID)).toBeNull()
    expect(store).not.toHaveBeenCalled()
  })

  it('proposes nothing when a hostile manifest names bytes that are not an image', async () => {
    const { picker, store } = harness()
    store.mockClear()
    const client = coverArt({
      front: netOk([candidate(true, 'front')]),
      bytes: netOk(Buffer.from('not an image'))
    })
    expect(await picker.proposeFromRelease(client, MBID)).toBeNull()
    expect(store).not.toHaveBeenCalled()
  })
})
