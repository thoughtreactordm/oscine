---
taskId: 01KYWWZJWPJZN8Y8TTMCH2BBQC
title: Audio and playback settings domain
status: in-review
priority: medium
labels: []
workstream: W8
workstreamId: W8-9
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
  - 01KYWWXGZJQTETFDRY6VGTRA3H
order: 36
created: '2026-07-31T20:13:50.868Z'
updated: '2026-08-01T16:30:16.724Z'
---
The domain with the most knobs already implemented — as constants, as function arguments, as values with no UI. This card turns them into descriptors.

## Keys

- `audio.gapless.enabled`, `audio.crossfadeMs` — cascading to playlist, and carrying the invariant: `crossfadeMs == 0` means gapless, non-zero means crossfade, **never both**. The registry cannot express a cross-key invariant on its own, so this needs a validated pair — setting one adjusts or rejects the other, and the rule holds at every cascade level, not just global. This is R2 and it is the reason this card is not simply data entry.
- `audio.replayGain.mode` (`off` / `track` / `album`), `audio.replayGain.preamp`, `audio.replayGain.fallbackGain`, `audio.replayGain.computeWhenMissing` — the last one gates the existing background job.
- `audio.outputDevice` — enumerated from the renderer, `requiresRestart` or live depending on what the engine supports; whichever it is, the flag must tell the truth. Machine-local, so W8-13 excludes it from export.
- Advanced tier, from R1: per-track decode cap, total decode budget, prefetch depth. These currently live as constants in the admission guard. Exposing them as `advanced` keys is better than leaving them as magic numbers, but the guard must keep enforcing its own floor — an operator must not be able to set a budget that makes a long-track library crash. Clamp in `validate`, and say so in the help text.

## Rules

Every value moves out of its constant and into a descriptor; nothing keeps a private default. The `AudioEngine` interface reads settings reactively (W8-4) so a change lands at the next boundary — the interface is the seam R1 needs, and settings must not be the thing that breaks it.

## Done when

- The gapless/crossfade exclusivity is tested at global level, at playlist-override level, and across a change to the global while an override exists.
- R1 clamps hold against out-of-range operator input, with a test that tries to exceed them.
- No audio default remains hardcoded outside the registry.

## What was built

Keys use the flat naming W8-5 already shipped (`audio.replayGainMode`, not
`audio.replayGain.mode`) — migration 006 and the crossfade cascade are written
against those, and renaming them would have cost a migration for nothing.

**`audio.gapless.enabled` was not added, and the invariant is stronger for it.**
A validated pair has four states and two of them — gapless *with* a crossfade,
and neither — are exactly what "never both" forbids. Any validator policing them
would be repairing a state the schema should not have been able to hold, at every
level of the cascade, forever. One number has two states and they are the two
legal ones, which is what folding the per-playlist crossfade column into
`audio.crossfadeMs` (W8-5) already bought. So the pair is a *derivation*:
`boundaryPolicy(resolvedCrossfadeMs)` in `src/shared/settings/audio.ts` returns
`gapless` or `crossfade` and nothing else, and it is total over every value any
cascade level can produce. The card's requirement is met — the rule holds at
every level — and it is met structurally rather than by a guard that could be
forgotten.

`audio.outputDevice` is live, not `requiresRestart`, and the flag says so. Both
paths reach the device through an `AudioContext`, so `AudioOutputRouter`
(`src/renderer/audio/outputDevice.ts`) re-points every live context and adopts
each new one. It sits on the engine *factory* rather than on `AudioEngine`,
because the decoded path shares one pooled context between both scheduler slots —
a per-engine setter would have been four objects each setting a device two of
them share. Its picker is the registry's first custom control, and it earns the
hatch: the options are whatever hardware is plugged in right now.

`audio.prefetchDepth` is bounded 0–1 rather than open-ended. The scheduler has
one prefetch slot — that is what makes a sample-accurate join possible — so a
larger depth would be a number the scheduler ignores. The help text says so.

R1's clamps are applied twice on purpose: in `validate`, which is the bound an
operator sees, and again in `resolveR1Policy`, which is the one that has to hold
when a value reaches the guard without passing a descriptor. An earlier draft
also raised the residency budget to meet the per-track cap; a pre-existing test
caught it, and it was wrong — the cap prices one settled buffer while the budget
prices current plus prefetch plus the transient decode peak, so a budget under
the cap is a stricter limit, not a contradiction. Raising it would have handed
the operator more memory than they asked for.

Two drifts were reconciled rather than preserved. `audio.replayGainMode`
defaulted to `album` in the registry while `DEFAULT_NORMALIZATION_MODE` in the
renderer said `track`, and the renderer's copy was the one playback used — so the
settings view had been advertising a default the app did not have. Deleting the
renderer constant makes the key authoritative, and the value kept is `track`,
the documented M2 default: changing what people hear is not this card's to do.

## Verified in the running app

A second instance against a throwaway user-data directory (CDP on 9335):

- All nine audio rows render, four visible and five behind the advanced tier.
- The output-device picker lists System default plus the three real sinks on this
  machine. It threw on first run — Reka's `SelectItem` refuses an empty-string
  value, and `''` is what `setSinkId` means by the system default — so the empty
  string now stops at the control's edge and a sentinel is used inside the
  select. Found live; unit tests would not have caught it.
- Clamps hold through real IPC and SQLite: 100000 → 1024 MiB, 1 → 64 MiB,
  9 → 1, −99 → −15 dB.
- `startReplayGain` with `audio.replayGainComputeWhenMissing` off returns
  `conflict: "Analysing untagged tracks is turned off in audio settings."`, and
  succeeds once it is back on.
