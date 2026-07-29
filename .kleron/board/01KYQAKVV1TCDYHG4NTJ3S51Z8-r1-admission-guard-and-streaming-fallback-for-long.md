---
taskId: 01KYQAKVV1TCDYHG4NTJ3S51Z8
title: R1 admission guard and streaming fallback for long tracks
status: todo
priority: urgent
labels:
  - M2
  - R1
  - audio
  - streaming
workstream: W3
workstreamId: W3-5
dependsOn:
  - 01KYQ4PVJFTR2GE71Z5E8DCHH2
  - 01KYQ4QA76HX5WZTS0T9Z480T1
  - 01KYQ4QTJ2SX17X2J3BM1NAFNH
effort: high
order: 0
created: '2026-07-29T16:16:40.288Z'
updated: '2026-07-29T16:16:40.288Z'
---
Turn the three R1 findings from the M1 exit gate into the policy that prevents whole-buffer decode from exhausting the renderer, while keeping long-form audio playable.

The arithmetic and conservative ledger already exist from W3-2, W3-3 and W3-4. This card wires them into the engine and adds the fallback path; it does not re-measure those findings.

## Scope

- Introduce an explicit, configurable R1 policy with the design defaults: 250 MiB maximum settled decoded size per track and 600 MiB total decoded residency budget.
- Before fetching or decoding, price the track at `AudioContext.sampleRate`. Use the settled decoded estimate for the per-track decision and `estimatedDecodedBytes × 2 + encodedBytes` for transient admission, based on the cross-platform M1 measurements.
- Count `DecodedBufferLedger.issuedNotFreedBytes` as live when enforcing the total budget. A dropped reference is not available headroom until collection is proven.
- Treat missing duration/channel metadata as unpriceable and route it to streaming. Unknown cost must never be interpreted as zero cost.
- Add a streaming implementation using `HTMLAudioElement` through `MediaElementAudioSourceNode`, behind the existing `AudioEngine` boundary and factory. The UI must not know which implementation a track uses.
- Preserve play, pause, seek, volume, time, duration, ended and error semantics on the streaming path. Track URLs still resolve by opaque track id through `fermata://`; no filesystem path crosses into the renderer.
- Streaming tracks get the R2 hard-transition policy. They are never advertised as gapless or crossfade-capable.
- Make load cancellation race-safe. A superseded fetch/decode may still have allocated memory and must remain accounted for.
- Emit structured diagnostic information for the admission decision and reason, without absolute paths.

## Acceptance

- Tracks below both limits still use whole-buffer decode.
- A track above the per-track cap, a track whose transient reservation would exceed available budget, and a track with unknown pricing metadata all select streaming before a whole-buffer decode starts.
- Streaming playback supports play/pause/seek/volume and natural-end events through the unchanged `AudioEngine` contract.
- Unit tests pin the threshold boundaries, context-rate pricing, transient reservation, uncollected-buffer accounting, unknown metadata, and superseded-load races.
- An integration probe demonstrates that a synthetic twenty-minute track selected for fallback stays within the configured memory budget and becomes audible without waiting for a full decode.

## Non-goals

No prefetch, gapless scheduling or crossfade here. This card establishes the safe two-path engine that the scheduler can consume.
