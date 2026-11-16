import type Database from 'better-sqlite3'
import {
  REPLAYGAIN_MIXED_ALBUM_DESELECT_DB,
  type ReplayGainStageResult,
  type ReplayGainStageSkipReason
} from '@shared/library'
import { REPLAYGAIN_TAG_KEYS, type TagFieldPatch } from '@shared/tagFields'
import { TagOverrideStore } from '../library/overrides/tagOverrides'

interface TrackRow {
  id: number
  source: 'tag' | 'computed' | null
  trackGain: number | null
  trackPeak: number | null
  albumGain: number | null
  albumPeak: number | null
  failed: number
}

/** A staging pass's result plus the tracks it touched, for the change feed. */
export interface ReplayGainStageOutcome extends ReplayGainStageResult {
  trackIds: number[]
}

const TRACK_COLUMNS = `
  t.id AS id, t.rg_source AS source,
  t.rg_track_gain AS trackGain, t.rg_track_peak AS trackPeak,
  t.rg_album_gain AS albumGain, t.rg_album_peak AS albumPeak,
  EXISTS (
    SELECT 1 FROM replaygain_job_items i
    WHERE i.job_id = (SELECT max(id) FROM replaygain_jobs)
      AND i.track_id = t.id AND i.status = 'failed'
  ) AS failed
`

/**
 * Turns Oscine's own measurements (`rg_source = 'computed'`) into staged
 * `track_tag_overrides` rows — **W25-4**, `oscine-replaygain` D37 Decisions C,
 * D and F. This is the *only* writer of ReplayGain rows: the hand-edit path
 * (`setTagOverrides`) refuses them (Decision B), so this goes to the
 * {@link TagOverrideStore} directly.
 *
 * - **C — whole albums or nothing.** An album with any unmeasured or failed
 *   track, or a measured track lacking the finalized album gain, is skipped and
 *   reported. A single (no `album_id`) stages track gain and peak only.
 * - **D — fill gaps, never overwrite silently.** The album gain goes to every
 *   computed track, and to a tagged track whose file has none. A tagged track
 *   whose own album gain differs by more than
 *   {@link REPLAYGAIN_MIXED_ALBUM_DESELECT_DB} is staged too — the review shows
 *   it deselected. One within that margin is left alone. A tagged track's track
 *   gain is never staged.
 * - **F — a snapshot.** Each staged album or single first drops its old
 *   ReplayGain rows, so re-staging replaces rather than accumulates; the job
 *   store deletes them when a track is re-measured.
 *
 * Podcast episodes need no filter: they are never rows in `tracks` (D16).
 */
export class ReplayGainStagingService {
  private readonly overrides: TagOverrideStore

  constructor(private readonly db: Database.Database) {
    this.overrides = new TagOverrideStore(db)
  }

  /**
   * Stages the named albums, or — with no `albumIds` — every album holding a
   * computed track plus every computed single. All in one transaction.
   */
  stage(request: { albumIds?: readonly number[] } = {}): ReplayGainStageOutcome {
    return this.db.transaction(() => {
      const explicit = request.albumIds !== undefined
      const albumIds = explicit
        ? [...new Set(request.albumIds)]
        : (
            this.db
              .prepare(
                `SELECT DISTINCT album_id AS albumId FROM tracks
                 WHERE rg_source = 'computed' AND album_id IS NOT NULL
                 ORDER BY album_id`
              )
              .all() as Array<{ albumId: number }>
          ).map((row) => row.albumId)

      const now = Date.now()
      const touched: number[] = []
      const skipped: ReplayGainStageResult['skipped'] = []
      let stagedAlbums = 0

      const albumTracks = this.db.prepare(
        `SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.album_id = ? ORDER BY t.id`
      )
      for (const albumId of albumIds) {
        const rows = albumTracks.all(albumId) as TrackRow[]
        const plan = planAlbum(rows)
        if ('reason' in plan) {
          skipped.push({ albumId, reason: plan.reason })
          continue
        }
        this.replace(
          rows.map((row) => row.id),
          plan.patches,
          now
        )
        for (const [trackId] of plan.patches) touched.push(trackId)
        stagedAlbums += 1
      }

      if (!explicit) {
        const singles = this.db
          .prepare(
            `SELECT ${TRACK_COLUMNS} FROM tracks t
             WHERE t.album_id IS NULL AND t.rg_source = 'computed'
             ORDER BY t.id`
          )
          .all() as TrackRow[]
        const patches = new Map<number, TagFieldPatch>()
        for (const row of singles) {
          const patch = trackPatch(row)
          if (patch !== null) patches.set(row.id, patch)
        }
        this.replace([...patches.keys()], patches, now)
        touched.push(...patches.keys())
      }

      return { stagedTracks: touched.length, stagedAlbums, skipped, trackIds: touched }
    })()
  }

  /** Drops the tracks' ReplayGain rows, then writes the new patches. */
  private replace(
    trackIds: readonly number[],
    patches: ReadonlyMap<number, TagFieldPatch>,
    now: number
  ): void {
    this.overrides.revert(trackIds, REPLAYGAIN_TAG_KEYS)
    for (const [trackId, patch] of patches) this.overrides.set([trackId], patch, now)
  }
}

/** A computed track's own gain and peak, or `null` when there is no gain. */
function trackPatch(row: TrackRow): TagFieldPatch | null {
  if (row.source !== 'computed' || row.trackGain === null) return null
  return {
    replayGainTrackGain: row.trackGain,
    ...(row.trackPeak !== null ? { replayGainTrackPeak: row.trackPeak } : {})
  }
}

type AlbumPlan = { patches: Map<number, TagFieldPatch> } | { reason: ReplayGainStageSkipReason }

/** Decisions C and D for one album's rows: what each track stages, or why none do. */
function planAlbum(rows: readonly TrackRow[]): AlbumPlan {
  if (rows.length === 0) return { reason: 'not-found' }
  const unmeasured = rows.filter((row) => row.source === null)
  if (unmeasured.some((row) => row.failed)) return { reason: 'failed' }
  if (unmeasured.length > 0) return { reason: 'unmeasured' }

  const computed = rows.filter((row) => row.source === 'computed')
  if (computed.length === 0) return { reason: 'nothing-measured' }

  // finalizeAlbum writes one album gain to every computed track; anything
  // else — a missing value, or two that disagree — means it never finished.
  const albumGain = computed[0]!.albumGain
  const albumPeak = computed[0]!.albumPeak
  if (
    albumGain === null ||
    computed.some(
      (row) => row.trackGain === null || row.albumGain !== albumGain || row.albumPeak !== albumPeak
    )
  ) {
    return { reason: 'missing-album-gain' }
  }

  const album: TagFieldPatch = {
    replayGainAlbumGain: albumGain,
    ...(albumPeak !== null ? { replayGainAlbumPeak: albumPeak } : {})
  }
  const patches = new Map<number, TagFieldPatch>()
  for (const row of rows) {
    if (row.source === 'computed') {
      patches.set(row.id, { ...trackPatch(row), ...album })
    } else if (
      row.albumGain === null ||
      Math.abs(row.albumGain - albumGain) > REPLAYGAIN_MIXED_ALBUM_DESELECT_DB
    ) {
      // Tagged: fill a missing album gain, or stage a differing one for the
      // review to show deselected. Its track gain is the file's and stays.
      patches.set(row.id, album)
    }
  }
  return { patches }
}
