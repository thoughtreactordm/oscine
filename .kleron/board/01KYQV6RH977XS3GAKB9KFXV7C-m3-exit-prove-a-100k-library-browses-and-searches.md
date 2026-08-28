---
taskId: 01KYQV6RH977XS3GAKB9KFXV7C
title: 'M3 exit: prove a 100k library browses and searches within frame budget'
status: done
priority: high
labels:
  - M3
  - milestone-exit
  - scale
  - cross-platform
  - performance
workstream: W6
workstreamId: W6-5
dependsOn:
  - 01KYQV3V8PD4GETWCWTJ6AP5D2
  - 01KYQV4CS1DA0HKWBXSBMX9DWR
  - 01KYQV4V9RHN8JW54DJEYNZ51T
  - 01KYQV5FCHTQ9JTDFBAMXHA75X
  - 01KYQV63WZB2PJ7PNTVY8XJJS4
effort: high
order: 8
created: '2026-07-29T21:06:36.712Z'
updated: '2026-08-28T19:48:16.285Z'
---
Turn M3's exit sentence into a repeatable gate with evidence from the same commit on Windows and Linux.

## Scheduling note

This card does **not** depend on W6-4. M3 implementation and even probe development may proceed while M2's Windows exit evidence is outstanding because the work is library/UI dominated. However, do not change the project's declared current milestone to M3 or claim M3 complete until W6-4 has closed M2 in sequence.

## Scope

- Extend the deterministic seed to exactly 100k tracks with realistic artist/album cardinality, null tags, Unicode/diacritics, known true-infix search cases and a bounded repeated-artwork set.
- Add an npm-driven, clean-commit probe that launches the built app against isolated user data and drives Artist → Album → Song browsing, sorting, instant search, rapid query replacement, deep scrolling, large multi-selection and column reconfiguration.
- Measure direct warm query latency, end-to-end result latency after the configured debounce, renderer scripting time per frame, long tasks, dropped-frame/rAF distribution, DOM node counts and retained page/selection state.
- Exercise startup incremental reconciliation plus live add/change/rename/delete. Fault-inject R3 `ENOSPC` and assert one visible actionable degradation notice.
- Verify artwork dedup/cache bounds and that missing/corrupt art produces placeholders without console errors.
- Capture warnings, errors, unhandled rejections and leaked watchers/workers. Run the ordinary repository gate on both platforms.
- Write `m3-exit-<platform>.md` reports containing commit, dirty state, hardware/runtime context, raw percentiles and pass/fail thresholds.

## Quantitative exit criteria

- Warm first-page browse/search SQL is at or under 16.7 ms p95 on the reference 100k fixture; any slower query is named with its plan.
- Renderer scripting for the driven browse/search interactions is at or under 16.7 ms p95, with no task over 50 ms.
- End-to-end settled search results appear within 100 ms after debounce, with no stale result ever painted.
- Artist, album and song DOM node counts remain flat from top to bottom; a 10k-row selection does not change rendered row count or retain full track objects.
- Watcher and artwork cache counts remain bounded and return to baseline after teardown.
- Windows and Linux reports from the same clean commit pass, with unexpected platform differences filed as separate triage cards.

## Handoff

Attach both reports to this card. Once this gate and W6-4 are both closed, update the README/planning status in a separate documentation commit. Evidence is the gate; the status edit merely declares the already-proven transition.
