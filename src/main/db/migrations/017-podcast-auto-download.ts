import type { Migration } from '../migrate'
import { DEFAULT_KEEP_LAST } from '@shared/podcasts'

/**
 * Per-pod auto-download and the auto/manual distinction — **P4**.
 *
 * `podcasts.auto_download` is the per-show toggle (off by default); when on, a
 * refresh keeps the newest `keep_last` episodes on disk. `keep_last` shipped in
 * 005 as a dead placeholder defaulting to 10; P4 gives it meaning with a
 * default of 3, so existing rows are normalised down — nothing read the old
 * value, so this cannot clobber a user choice.
 *
 * `episodes.auto_downloaded` is what makes "prune the oldest auto-download, but
 * never a manually-kept episode" expressible: prune considers only rows this
 * flag marks, so a file the user pulled by hand is invisible to it. Manual
 * downloads clear the flag; clearing a download resets it (`store.clearDownload`).
 */
export const podcastAutoDownload: Migration = {
  version: 17,
  name: 'podcast-auto-download',
  sql: `
ALTER TABLE podcasts ADD COLUMN auto_download INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN auto_downloaded INTEGER NOT NULL DEFAULT 0;
`,
  /**
   * Re-home the dead `keep_last` default (10) onto P4's default (3). A JS step
   * because the value is the shared constant, not a literal duplicated in SQL.
   */
  backfill: (db) => {
    db.prepare(`UPDATE podcasts SET keep_last = ?`).run(DEFAULT_KEEP_LAST)
  }
}
