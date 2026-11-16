import type { Migration } from '../migrate'

/**
 * Forced ReplayGain re-measure — **W25-7**, `oscine-replaygain` (RG-7).
 *
 * `forced` is a property of the job, not of its items, because it changes the
 * rule a finished item lands under: an ordinary job only fills a track whose
 * `rg_source` is still NULL (the tagged-value race rule), while a forced one
 * overwrites a `'computed'` or `'tag'` value in the database. The file is not
 * touched either way — a forced result reaches it only through staging and the
 * W16 review (D37). Stored rather than held in memory so a paused forced job
 * resumes under the rule it was started with.
 */
export const replayGainForcedJobs: Migration = {
  version: 32,
  name: 'replaygain-forced-jobs',
  sql: `
ALTER TABLE replaygain_jobs ADD COLUMN forced INTEGER NOT NULL DEFAULT 0
  CHECK (forced IN (0, 1));
`
}
