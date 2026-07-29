---
taskId: 01KYQAQKV9YX20XQF9NE4WSKJK
title: ReplayGain compute-when-missing background job
status: done
priority: high
labels:
  - M2
  - ReplayGain
  - background-job
  - cross-platform
workstream: W2
workstreamId: W2-4
dependsOn:
  - 01KYECGN8JRHFBMDEBTRS9ZT1E
  - 01KYQAPNHCVJFAZKAJMMNNRB4W
effort: xhigh
order: 10
created: '2026-07-29T16:18:43.176Z'
updated: '2026-07-29T19:48:31.279Z'
---
Compute ReplayGain only for tracks that do not already carry tags, using a resumable background job that never blocks the main process or reaches into the renderer filesystem boundary.

This is in W2 because it owns SQLite, absolute-path resolution and the background job queue. The values it writes implement the contract consumed by W3.

## Scope

- Put the analysis backend behind a small adapter. As the first implementation checkpoint, verify the chosen backend against deterministic audio fixtures and Windows/Linux packaging constraints. Do not depend on an executable that will be present on a developer machine but absent from the shipped app.
- Analyze track loudness and peak with ReplayGain-compatible semantics and store `rg_track_gain`, `rg_track_peak` and `rg_source = 'computed'`.
- Compute album gain/peak for complete album groups and write the album values back to their member tracks. Define how incomplete/failed albums resume without discarding successful track analysis.
- Select only rows with no tagged or computed result. Existing `rg_source = 'tag'` values are authoritative and must never be overwritten by the job.
- Run analysis outside the main event loop, with bounded concurrency. Scanning, IPC and playback controls must remain responsive while it runs.
- Add the minimal durable job state needed for progress, cooperative cancel and resume across app restarts. Checkpoint at track-sized units so cancellation does not lose completed work.
- Expose narrow typed IPC for starting, observing, cancelling and resuming the job. Progress identifies counts and safe display metadata, never an absolute path.
- Resolve files from trusted track ids in main. Missing/unreadable/corrupt files become per-item failures and do not abort the library job.
- Ensure scanner behavior agrees with the ReplayGain application card: an untagged rescan preserves computed values; newly discovered real tags replace them.

## Acceptance

- Known fixtures produce track gain/peak and album gain/peak within a documented tolerance of the reference backend.
- Tagged tracks are skipped and remain byte-for-byte unchanged.
- Cancellation stops new work promptly, preserves completed results and leaves a resumable checkpoint; relaunch-and-resume finishes without recomputing completed tracks.
- Per-file failure is recorded and progress continues. Retry behavior is explicit and tested.
- A large synthetic queue demonstrates bounded worker/process count and a responsive main event loop.
- The packaged analysis path is verified on both Windows and Linux, including cleanup of workers or child processes on cancel and app quit.
- Newly written values are observed by the renderer and applied on the next load without a library rescan.

## Non-goals

No waveform cache, BPM/key analysis or general-purpose media job UI. Build only the reusable job seam M2 needs for ReplayGain.

## Verification

- ReplayGain 2.0 DSP uses BS.1770 K-weighting, 400 ms gated blocks, a -18 LUFS target and sample
  peak. The deterministic 1 kHz fixture tolerance and backend/packaging contract are recorded in
  `docs/REPLAYGAIN.md`.
- `node-web-audio-api` is a production dependency and adapter implementation; no external
  executable is assumed. The named worker build entry is exercised after build by
  `npm run probe:replaygain` on both platforms in the CI matrix.
- SQLite migration 3 adds durable job and track-sized checkpoint rows. Tests cover tagged-row
  exclusion, guarded writes, two-worker concurrency, per-file failure, explicit fresh-job retry,
  cancel, database close/reopen/resume without recomputing completed work, and album finalisation
  from results retained across jobs.
- The typed shared contract exposes start, status, cancel, resume and progress events. Progress
  contains counts and a track title only; absolute-path resolution stays in main and safe errors
  persist no path.
- Shutdown pauses the job, returns running items to pending, awaits worker termination, then closes
  SQLite. Scanner tests already prove untagged rescans preserve computed values and real tags replace
  them.
- Local gate: format, lint, typecheck, 322 tests, production build, the emitted Linux/x64 worker
  probe, and the Electron 43 native-ABI decoder check pass. The matrixed Windows probe remains the
  review/CI platform check.
