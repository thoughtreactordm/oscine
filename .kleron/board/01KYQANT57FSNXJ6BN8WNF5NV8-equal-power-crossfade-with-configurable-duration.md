---
taskId: 01KYQANT57FSNXJ6BN8WNF5NV8
title: Equal-power crossfade with configurable duration
status: todo
priority: high
labels:
  - M2
  - R2
  - audio
  - crossfade
workstream: W3
workstreamId: W3-8
dependsOn:
  - 01KYQAN5NCZX2HXED8JJWNJD5D
effort: high
order: 3
created: '2026-07-29T16:17:44.102Z'
updated: '2026-07-29T16:17:44.102Z'
---
Add the non-zero half of R2: overlap decoded tracks with an equal-power curve for a configurable duration, using the same scheduler as gapless rather than a second transition mechanism.

M4 will source the value from each playlist row. Until playlists exist, expose the setting at the playback/scheduler boundary and use a small development control or test harness without inventing a second persistence model.

## Scope

- Treat `crossfade_ms > 0` as crossfade and `crossfade_ms === 0` as gapless. Exactly one policy is selected for every boundary.
- Give each scheduled source its own transition-gain stage, separate from ReplayGain and the user's master volume.
- Start the next decoded source at `currentEndTime - effectiveCrossfadeDuration` and apply complementary equal-power curves (`cos`/`sin` or an equivalent power-preserving curve) to outgoing and incoming gains.
- Clamp the effective duration deterministically for very short tracks and late prefetch. Record when the requested duration cannot be honored; never schedule a source before it is ready or before its valid start.
- Seeking, skipping, pausing, stopping and changing the duration while a boundary is planned must cancel or rebuild automation without clicks, leaked nodes or a stale fade completing later.
- Any boundary involving the streaming fallback remains a hard transition, as required by R1/R2.
- Keep the public engine abstraction free of Web Audio types. Playlist integration later should only pass a duration value.

## Acceptance

- Automated graph tests verify the outgoing and incoming gains at the start, midpoint and end of the overlap, including approximately constant summed power at the midpoint.
- The overlap begins and ends at the expected AudioContext times for multiple durations and sample rates.
- Zero duration executes only the gapless path; non-zero duration executes only the crossfade path.
- Short-track clamping, late-prefetch degradation, streaming boundaries and cancellation races are covered.
- Repeated transitions do not accumulate connected sources or automation, and master-volume changes remain click-free during a fade.
- Manual verification records at least two durations and confirms no audible level dip, spike or click.

## Non-goals

No crossfade curve editor and no playlist UI in M2. The stable input is duration in milliseconds; M4 owns feeding it from `playlists.crossfade_ms`.
