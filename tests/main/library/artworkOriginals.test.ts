import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArtworkOriginalsStore } from '../../../src/main/library/artworkOriginals'
import { artworkHash } from '../../../src/main/library/derivedArtwork'

/**
 * The override-originals store — **W16-9**.
 *
 * Full-resolution cover bytes, content-addressed by the same SHA-256 the diff
 * and thumbnail cache use, refcounted over `artwork_overrides.image_hash`. The
 * properties that matter: bytes round-trip by hash, byte-identical covers dedupe
 * to one file, and the GC drops exactly the originals no live override names.
 */
describe('artwork originals store', () => {
  let dir: string
  let store: ReturnType<typeof createArtworkOriginalsStore>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-originals-'))
    store = createArtworkOriginalsStore({ dir: join(dir, 'artwork-originals') })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips full-resolution bytes by hash', async () => {
    const bytes = Buffer.from('full-resolution-cover-bytes')
    const returned = await store.put(bytes)

    expect(returned).toBe(artworkHash(bytes))
    expect(await store.has(returned)).toBe(true)
    const read = await store.read(returned)
    expect(read).not.toBeNull()
    expect(Buffer.from(read!).equals(bytes)).toBe(true)
  })

  it('reads absent as null and rejects a non-hash key without touching disk', async () => {
    expect(await store.read(artworkHash(Buffer.from('never stored')))).toBeNull()
    expect(await store.read('../escape')).toBeNull()
    expect(await store.has('not-a-hash')).toBe(false)
  })

  it('deduplicates byte-identical covers to one file', async () => {
    const bytes = Buffer.from('shared-album-cover')
    const a = await store.put(bytes)
    const b = await store.put(bytes)

    expect(a).toBe(b)
    const files = await readdir(join(dir, 'artwork-originals'))
    expect(files).toEqual([a])
  })

  it('gc drops an unreferenced original and keeps a referenced one', async () => {
    const kept = await store.put(Buffer.from('still-chosen'))
    const orphan = await store.put(Buffer.from('override-was-retired'))

    const removed = await store.gc(new Set([kept]))

    expect(removed).toBe(1)
    expect(await store.has(kept)).toBe(true)
    expect(await store.has(orphan)).toBe(false)
  })

  it('gc over an empty reference set clears the store', async () => {
    await store.put(Buffer.from('one'))
    await store.put(Buffer.from('two'))

    expect(await store.gc(new Set())).toBe(2)
    expect(await readdir(join(dir, 'artwork-originals'))).toEqual([])
  })

  it('gc sweeps a leftover temp file from an interrupted put', async () => {
    const kept = await store.put(Buffer.from('complete'))
    await writeFile(join(dir, 'artwork-originals', `${kept}.tmp`), 'half a write')

    const removed = await store.gc(new Set([kept]))

    expect(removed).toBe(1)
    expect(await readdir(join(dir, 'artwork-originals'))).toEqual([kept])
  })

  it('gc on a store that was never written is a no-op, not an error', async () => {
    expect(await store.gc(new Set())).toBe(0)
  })
})
