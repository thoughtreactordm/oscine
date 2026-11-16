import type Database from 'better-sqlite3'
import type { ReplayGain } from '../library/metadata'

/**
 * Brings a track's `rg_*` columns in line with its file after a ReplayGain
 * flush. This is **W25-6**, and it answers `oscine-replaygain` open question 5.
 *
 * The write-back flush does not re-index the file. Without this step the
 * track would keep `rg_source = 'computed'` until the next scan noticed the
 * new mtime, and the source label would say "measured — not in file" about a
 * value that now is in the file. So the flush re-reads the file and the track
 * takes what it holds:
 *
 * - **The file carries a track gain.** The row takes all four of the file's
 *   values and flips to `'tag'`, exactly as a scan of the same file would.
 * - **The file carries an album gain only.** This happens when the operator
 *   flushed the album scope but deselected the track gain. Only the album
 *   columns are refreshed and the source is kept. Flipping it would label the
 *   measured track gain as "from file", and taking the file's empty track gain
 *   would throw the measurement away.
 * - **The file carries neither.** Nothing changes.
 *
 * Returns whether the row changed.
 */
export function applyFlushedReplayGain(
  db: Database.Database,
  trackId: number,
  gain: ReplayGain | null
): boolean {
  if (gain === null) return false
  if (gain.trackGainDb !== null) {
    return (
      db
        .prepare(
          `UPDATE tracks
           SET rg_track_gain = ?, rg_track_peak = ?, rg_album_gain = ?, rg_album_peak = ?,
               rg_source = 'tag'
           WHERE id = ?`
        )
        .run(gain.trackGainDb, gain.trackPeak, gain.albumGainDb, gain.albumPeak, trackId).changes >
      0
    )
  }
  if (gain.albumGainDb !== null) {
    return (
      db
        .prepare(`UPDATE tracks SET rg_album_gain = ?, rg_album_peak = ? WHERE id = ?`)
        .run(gain.albumGainDb, gain.albumPeak, trackId).changes > 0
    )
  }
  return false
}
