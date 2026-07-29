---
taskId: 01KYQAN5NCZX2HXED8JJWNJD5D
title: Sample-accurate gapless boundaries
status: done
priority: high
labels:
  - M2
  - R2
  - audio
  - gapless
  - milestone-exit
workstream: W3
workstreamId: W3-7
dependsOn:
  - 01KYQAMF536T5PFR2GEXJ7PFYT
effort: high
order: 8
created: '2026-07-29T16:17:23.115Z'
updated: '2026-07-29T19:48:31.252Z'
---
Implement R2's zero-crossfade policy on top of the decode-ahead scheduler and prove the boundary by samples, not by listening.

## Scope

- When `crossfade_ms === 0` and both sides are decoded sources, schedule the next source at exactly `currentStartTime + currentBuffer.duration` on the same AudioContext timeline.
- Promote the prefetched source to current without stopping and rebuilding it at the boundary. Track/status/time events must change ownership once, at the scheduled boundary, without an `ended` race triggering a second transition.
- Carry scheduling through pause/resume, seek, skip, stop, natural end and AudioContext suspension. Operations that invalidate the planned boundary must cancel it cleanly and establish a new timeline.
- If either side uses R1 streaming fallback, take the explicitly documented hard-transition path. Do not claim gapless for a MediaElement boundary.
- Keep crossfade mutually exclusive: this card handles only the exact zero-duration policy.
- Add a deterministic boundary fixture by splitting one continuous PCM signal into two tracks. Render the scheduled pair through an `OfflineAudioContext` or equivalent real Web Audio graph and compare the samples around the join with the unsplit reference.

## Acceptance

- The fixture contains neither a missing sample nor a duplicated sample at the join; the rendered boundary matches the continuous reference within a stated floating-point tolerance.
- The test fails if the second source is scheduled one sample early or one sample late, proving it detects the regression it names.
- No library lookup, fetch, decode or renderer timer lies on the successful decoded boundary.
- Natural-end and scheduler callbacks cannot advance twice.
- Streaming-involved boundaries are visibly classified as hard transitions and covered by tests.
- Manual verification on at least one known gapless album is recorded as supporting evidence, but does not replace the automated sample test.

## Non-goals

No fades in this card. Non-zero duration belongs to the crossfade card and follows a different scheduling policy.

## Verification

- Offline Web Audio rendering compares a split continuous PCM fixture with its unsplit reference at a `1e-7` tolerance.
- The fixture's one-sample-early and one-sample-late controls both fail that tolerance.
- Engine and scheduler tests cover exact shared-timeline scheduling through context suspension, adoption without a second `play`, duplicate end suppression, pause/resume, seek, skip, stop, non-zero crossfade exclusion, and hard fallback on either side.
- Automated gate: lint, format, typecheck, 284 tests, and production build pass.
- Manual known-gapless-album verification remains pending.
