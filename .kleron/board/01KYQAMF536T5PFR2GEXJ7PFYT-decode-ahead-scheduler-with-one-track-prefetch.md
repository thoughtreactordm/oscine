---
taskId: 01KYQAMF536T5PFR2GEXJ7PFYT
title: Decode-ahead scheduler with one-track prefetch
status: todo
priority: high
labels:
  - M2
  - audio
  - scheduler
  - prefetch
workstream: W3
workstreamId: W3-6
dependsOn:
  - 01KYQAKVV1TCDYHG4NTJ3S51Z8
  - 01KYQMNRX95CN5DW6N6YYEZKC1
effort: high
order: 1
created: '2026-07-29T16:17:00.066Z'
updated: '2026-07-29T16:17:00.066Z'
---
Replace ended-driven load-then-play with a scheduler that knows the next track while the current track is still playing. This is the load-bearing seam for both gapless and crossfade.

## Scope

- Add a playback scheduler above the engine implementations and below the Pinia/UI layer. The UI supplies play-order intent; it does not schedule Web Audio nodes itself.
- Resolve the next track from the existing play-order snapshot as soon as the current track is established, then prefetch exactly one track ahead.
- Keep all library lookup, URL resolution, fetch and whole-buffer decode off the audible boundary. The W2-3 scale fix is a prerequisite, but the boundary must not depend on a fresh database query even if that query is fast.
- Reserve R1 memory before a prefetch decode and release only according to the proven-freed ledger. If the next track cannot be admitted, prepare its streaming fallback instead.
- Model current and prefetched-next ownership explicitly. Skips, seeks, sort changes, rapid repeated next/previous commands, load failure and stop must invalidate stale work without allowing a late result to replace the intended track.
- Use AudioContext time for all audible scheduling. Renderer timers may wake maintenance work but are never the source of truth for a boundary.
- Preserve the current play-order snapshot semantics: sorting the viewed list after playback starts must not silently change the active traversal.
- Surface prefetch state and recoverable failure diagnostics without turning a next-track failure into failure of the track already playing.

## Acceptance

- During ordinary decoded playback, the next track is fetched and decoded before the current track ends, with no duplicate decode at the transition.
- No database query, protocol fetch or decode begins on the audible boundary in the success path.
- Rapid skip/previous/stop operations cannot promote a stale prefetched result; race tests exercise completion in every relevant order.
- Prefetch obeys the per-track and total R1 budgets and selects streaming when whole-buffer decode is inadmissible.
- A failed prefetch leaves the current track playing and takes a deterministic hard-transition/error path at the boundary.
- Existing controller, store and transport behavior remains intact through the new scheduler boundary.

## Non-goals

This card prepares and owns the next source but does not yet claim gapless or crossfade correctness. Those policies land in separate cards against this scheduler.
