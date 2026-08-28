import type Database from 'better-sqlite3'
import { artworkRef } from '@shared/artwork'
import type { PendingWrite } from '@shared/tagWriteback'
import { toAbsPath } from '../../db/paths'
import type { MetadataReader } from '../metadata'
import { readTrackTags } from '../metadata'
import {
  computePendingWrite,
  NO_OVERRIDE,
  type GenreCanonicalizer,
  type TrackOverrideRow,
  type WritebackUserTag
} from './diff'

/**
 * The pending-write orchestrator — **W16-1**, design authority D28.
 *
 * The impure half of the diff engine: it gathers a track's inputs from the
 * database and — crucially — from a *fresh read of the file*, then hands them to
 * the pure {@link computePendingWrite} merge. Kept apart from the merge for the
 * same reason `readTrackTags` is kept apart from `toTrackTags`: the rules are
 * testable without a file, and the one impure step is a single seam.
 *
 * The file read is where R7 is honoured. `current` in every diff comes from
 * `readTrackTags(absPath)`, not from the cached `tracks` row, so a file another
 * tool retagged since the last scan is diffed against its real bytes — the flush
 * reconciles the out-of-band edit instead of overwriting it with a stale value.
 * The reader is injected (defaulting to the real one) so the merge-plus-IO path
 * can be exercised in tests with a synthesised file.
 */
export class TagWritebackDiffer {
  private readonly statements: ReturnType<typeof prepareStatements>

  constructor(
    db: Database.Database,
    private readonly readTags: MetadataReader = readTrackTags
  ) {
    this.statements = prepareStatements(db)
  }

  /**
   * Computes one track's pending write, reading its file live.
   *
   * Returns `null` when the track does not exist or its path cannot be resolved
   * to a root — there is nothing on disk to diff against. A file that exists but
   * cannot be parsed (missing, corrupt, or deleted out-of-band) surfaces as the
   * reader's own throw: that is a per-file failure for the batch caller (W16-2)
   * to report, not a silent empty diff.
   */
  async pendingWrite(
    trackId: number,
    canonicalize?: GenreCanonicalizer
  ): Promise<PendingWrite | null> {
    const resolved = this.statements.resolveTrack.get(trackId) as
      { rootPath: string; relPath: string } | undefined
    if (resolved === undefined) return null

    const absPath = toAbsPath(resolved.rootPath, resolved.relPath)
    if (absPath === null) return null

    const file = await this.readTags(absPath)
    const override =
      (this.statements.override.get(trackId) as TrackOverrideRow | undefined) ?? NO_OVERRIDE
    const userTags = this.statements.userTags.all(trackId) as WritebackUserTag[]
    const artworkRow = this.statements.artwork.get(trackId) as
      | {
          fileHash: string | null
          overrideHash: string | null
          overrideMime: string | null
          hasOverride: number
        }
      | undefined

    return computePendingWrite({
      trackId,
      file,
      override,
      userTags,
      canonicalize,
      fileArtwork: artworkRef(artworkRow?.fileHash ?? null),
      artworkOverride:
        artworkRow !== undefined && artworkRow.hasOverride === 1
          ? { imageHash: artworkRow.overrideHash, mime: artworkRow.overrideMime }
          : null
    })
  }
}

function prepareStatements(db: Database.Database) {
  return {
    resolveTrack: db.prepare(`
      SELECT r.path AS rootPath, t.rel_path AS relPath
      FROM tracks t
      JOIN roots r ON r.id = t.root_id
      WHERE t.id = ?
    `),
    override: db.prepare(`
      SELECT title, artist_name, album_title, track_no, disc_no, genre, year
      FROM track_overrides
      WHERE track_id = ?
    `),
    // The two D28 layers below `track_overrides`: the free-form user vocabulary.
    // Suggested tags count — a suggestion the operator left in place is a tag they
    // adopted, and W15 names this set "precisely the diff to flush".
    userTags: db.prepare(`
      SELECT t.label AS label, tt.source AS source
      FROM track_tags tt
      JOIN tags t ON t.id = tt.tag_id
      WHERE tt.track_id = ? AND tt.source IN ('user', 'suggested')
      ORDER BY t.label COLLATE NOCASE, t.id
    `),
    // W16-12: the file's last-known cover (album hash the thumbnail cache
    // already holds) and the override row. `hasOverride` distinguishes a
    // clear (row, NULL hash) from absent (no row) — the CASE on image_hash
    // alone cannot, because both look like NULL.
    artwork: db.prepare(`
      SELECT al.artwork_hash AS fileHash,
             awo.image_hash AS overrideHash,
             awo.mime AS overrideMime,
             awo.track_id IS NOT NULL AS hasOverride
      FROM tracks t
      LEFT JOIN albums al ON al.id = t.album_id
      LEFT JOIN artwork_overrides awo ON awo.track_id = t.id
      WHERE t.id = ?
    `)
  }
}
