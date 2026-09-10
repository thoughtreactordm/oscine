import { readFile, stat } from 'node:fs/promises'
import { MAX_ARTWORK_INGEST_BYTES, sniffImageMime, type ArtworkRef } from '@shared/artwork'
import { OscineError } from '@shared/errors'
import type { DerivedArtworkStore } from '../library/derivedArtwork'

export interface RipCover {
  bytes: Uint8Array
  mime: string
}

/** One draft cover in memory; a running rip checkpoints its own copy in SQLite. */
export class RipArtworkPicker {
  private selected: { hash: string; cover: RipCover } | null = null

  constructor(
    private readonly pickFile: () => Promise<string | null>,
    private readonly derived: DerivedArtworkStore
  ) {}

  referencedHashes(): string[] {
    return this.selected ? [this.selected.hash] : []
  }

  resolve(hash: string): RipCover {
    if (this.selected?.hash !== hash) {
      throw new OscineError('not-found', 'Choose the album art again before ripping.')
    }
    return this.selected.cover
  }

  async pick(): Promise<ArtworkRef | null> {
    const path = await this.pickFile()
    if (path === null) return null
    let bytes: Uint8Array
    try {
      if ((await stat(path)).size > MAX_ARTWORK_INGEST_BYTES) {
        throw new OscineError(
          'invalid-request',
          'That image is too large. Choose a cover under 32 MB.'
        )
      }
      bytes = await readFile(path)
    } catch (error) {
      if (error instanceof OscineError) throw error
      throw new OscineError('io-error', 'That image could not be read.')
    }
    if (bytes.byteLength > MAX_ARTWORK_INGEST_BYTES) {
      throw new OscineError(
        'invalid-request',
        'That image is too large. Choose a cover under 32 MB.'
      )
    }
    const mime = sniffImageMime(bytes)
    if (!mime) throw new OscineError('invalid-request', 'Choose a JPEG or PNG image.')
    const stored = await this.derived.store(bytes, 'rip cover')
    if (!stored) throw new OscineError('invalid-request', 'That image could not be read.')
    this.selected = { hash: stored.hash, cover: { bytes, mime } }
    return { present: true, hash: stored.hash, mime }
  }
}
