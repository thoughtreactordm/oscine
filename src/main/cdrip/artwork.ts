import { readFile, stat } from 'node:fs/promises'
import { MAX_ARTWORK_INGEST_BYTES, sniffImageMime, type ArtworkRef } from '@shared/artwork'
import { OscineError } from '@shared/errors'
import type { CoverArtArchiveClient } from '../artwork/coverArtArchive'
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
    return this.ingest(bytes, 'rip cover')
  }

  /**
   * A release's front cover from the Cover Art Archive, dropped into the same
   * slot the file picker fills — **W7-16**. One new source above the identical
   * validate-and-store path, so a network-proposed cover is indistinguishable
   * from a picked file by the time the rip embeds it.
   *
   * A missing front, an empty manifest, a 404, or consent-off (which
   * `NetClient` surfaces as a failure at the socket) are all "no proposal", not
   * errors: this returns `null` and leaves the current selection untouched, so
   * the file picker stays the way in and the rip still completes. Only a fetch
   * that yields a usable front cover mutates the slot.
   */
  async proposeFromRelease(
    client: CoverArtArchiveClient,
    releaseMbid: string
  ): Promise<ArtworkRef | null> {
    const found = await client.releaseFront(releaseMbid)
    if (!found.ok) return null
    const front = found.value.find((candidate) => candidate.front)
    if (!front) return null
    const bytes = await client.fetchImageBytes(front.fullUrl)
    if (!bytes.ok) return null
    try {
      return await this.ingest(bytes.value, 'rip cover (network)')
    } catch {
      // A manifest that named bytes we cannot ingest — wrong format, over the
      // cap, or undecodable — is no different from a release with no cover.
      return null
    }
  }

  /** Validate bytes, store the preview, and take the slot. Shared by both sources. */
  private async ingest(bytes: Uint8Array, label: string): Promise<ArtworkRef> {
    if (bytes.byteLength > MAX_ARTWORK_INGEST_BYTES) {
      throw new OscineError(
        'invalid-request',
        'That image is too large. Choose a cover under 32 MB.'
      )
    }
    const mime = sniffImageMime(bytes)
    if (!mime) throw new OscineError('invalid-request', 'Choose a JPEG or PNG image.')
    const stored = await this.derived.store(bytes, label)
    if (!stored) throw new OscineError('invalid-request', 'That image could not be read.')
    this.selected = { hash: stored.hash, cover: { bytes, mime } }
    return { present: true, hash: stored.hash, mime }
  }
}
