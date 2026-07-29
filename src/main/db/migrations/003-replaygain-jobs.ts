import type { Migration } from '../migrate'

/**
 * A job row owns lifecycle state; item rows are track-sized checkpoints.
 *
 * Loudness histograms are retained across jobs. They let an interrupted or
 * partially failed album calculation finish later without decoding successful
 * tracks a second time.
 */
export const replayGainJobs: Migration = {
  version: 3,
  name: 'replaygain-jobs',
  sql: `
CREATE TABLE replaygain_jobs (
  id         INTEGER PRIMARY KEY,
  state      TEXT NOT NULL CHECK (state IN ('running', 'cancelling', 'paused', 'cancelled', 'completed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE replaygain_job_items (
  job_id             INTEGER NOT NULL REFERENCES replaygain_jobs(id) ON DELETE CASCADE,
  track_id           INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  loudness_histogram TEXT,
  peak               REAL,
  error              TEXT,
  PRIMARY KEY (job_id, track_id)
);

CREATE INDEX idx_rg_job_items_status
  ON replaygain_job_items(job_id, status, track_id);
`
}
