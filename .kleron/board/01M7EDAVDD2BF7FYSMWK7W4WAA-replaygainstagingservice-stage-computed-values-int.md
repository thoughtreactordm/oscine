---
taskId: 01M7EDAVDD2BF7FYSMWK7W4WAA
title: >-
  ReplayGainStagingService: stage computed values into track_tag_overrides
  (Decisions C, D, F)
status: todo
priority: medium
labels: []
workstream: W25
workstreamId: W25-4
dependsOn:
  - 01M7EDAF6X9BCSSQM1G94RJ6DK
order: 29
created: '2026-11-15T01:32:17.194Z'
updated: '2026-11-15T01:32:17.194Z'
---
**Phase 2 — RG-4.** The main-process service that turns `rg_source = 'computed'` rows into `track_tag_overrides` rows. Depends on RG-3 (the write gate must admit staged ReplayGain keys first).

**`ReplayGainStagingService` (main).** Returns `{ stagedTracks, stagedAlbums, skipped: Array<{ albumId, reason }> }`.

**New IPC:** `library.stageComputedReplayGain({ albumIds?: number[] })`. No argument means every eligible album.

**Decisions it must apply:**
- **Decision C — albums are staged whole or not at all.** An album gain is only correct if every track carries it. Staging skips an album with any track unmeasured, failed, or missing an album gain, and reports it with the reason. Singles (no `album_id`) stage track gain and peak only.
- **Decision D — mixed albums fill gaps, never overwrite silently.** `finalizeAlbum` already computes one album gain across tagged + computed tracks. Staging writes it to the computed tracks, and to tagged tracks whose file has **no** album gain. A tagged track whose existing album gain differs from the computed one by more than **0.1 dB** is staged but will render **deselected** in the review (RG-6), so the operator opts in per row. **Track gain on a tagged track is never staged.**
- **Decision F — staged values are a snapshot; re-measuring invalidates them.** If a later job re-measures a track, its staged ReplayGain rows are deleted **in the same transaction**, so a review never offers a stale measurement. The diff compares with tolerance (**gain ±0.005 dB, peak ±1e-6**) so re-staging identical values is not a pending change.

**Exclude podcasts** from staging (resolve with OQ3 in RG-1).

**Tests:** `tests/main/replaygain/staging.test.ts` covers C, D and F — incomplete album, single, mixed album with matching and differing tags, invalidation on re-measure.
