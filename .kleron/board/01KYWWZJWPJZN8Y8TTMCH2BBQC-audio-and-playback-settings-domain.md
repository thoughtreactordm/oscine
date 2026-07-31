---
taskId: 01KYWWZJWPJZN8Y8TTMCH2BBQC
title: Audio and playback settings domain
status: todo
priority: medium
labels: []
workstream: W8
workstreamId: W8-9
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
  - 01KYWWXGZJQTETFDRY6VGTRA3H
order: 36
created: '2026-07-31T20:13:50.868Z'
updated: '2026-07-31T20:13:50.868Z'
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
