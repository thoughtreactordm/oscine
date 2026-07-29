---
taskId: 01KYECHBRGWEZFS13A6DX4HTJJ
title: AudioEngine interface and decodeAudioData playback
status: in-review
priority: high
labels:
  - M1
  - R1
workstream: W3
workstreamId: W3-1
dependsOn:
  - 01KYECFMPA141ZPJM8F2X54BAS
effort: high
order: 0
created: '2026-07-26T04:57:05.551Z'
updated: '2026-07-29T01:01:16.215Z'
---
Make sound come out, behind an interface that can survive being replaced.

The interface is the point of this card. D2 accepted a pipeline with a known memory ceiling (**R1**), on the explicit condition that the implementation sits behind a boundary the UI never sees through. If R1 forces a WebCodecs rewrite at M2 or later, only the implementation changes.

## Scope

- Define `AudioEngine` in `src/renderer/audio` — an interface first, implementation second. Surface roughly: `load(trackId)`, `play()`, `pause()`, `seek(seconds)`, `setVolume(gain)`, `currentTime`, `duration`, plus events for ended, time-update and error.
- **Nothing in the interface may mention `AudioBuffer`, `decodeAudioData` or any Web Audio type.** If a Web Audio concept appears in the signature, the abstraction has already failed and the M2 swap will not be clean.
- `DecodedAudioEngine` implementing it: fetch bytes via the mechanism chosen in the IPC card, `decodeAudioData`, play through `AudioBufferSourceNode` → `GainNode` → destination.
- Volume via the gain node, not by scaling samples. M2 hangs ReplayGain and crossfade off this same node.
- Correct handling of the fact that `AudioBufferSourceNode` is single-use: a fresh node per play and per seek, with `currentTime` tracked against the AudioContext clock rather than assumed.
- Resume the AudioContext on first user gesture — Chromium autoplay policy applies inside Electron.

## Explicitly not in scope

No prefetch, no gapless, no crossfade, no ReplayGain. All M2. One track at a time, hard stop between tracks.

## Note on R1

M1 has no memory guard, so a very long track may allocate hundreds of megabytes here. That is accepted for M1 and is precisely the risk M2 exists to measure. **Log the decoded byte size on every load** — those numbers are the input to M2's threshold decision, and having real figures beats guessing.

## Acceptance

- MP3, FLAC and OGG all play, seek and report accurate duration.
- Volume changes are click-free.
- Playing a second track cleanly tears down the first with no leaked nodes.
- A reviewer can describe how a WebCodecs implementation would slot in without touching UI code.

---

# Outcome — done

Commits `e94c5f0`, `e59385d`, `ab94981`, `e73225e`.

## Shape

Six files in `src/renderer/audio`. The split is the deliverable:

- `AudioEngine.ts` — the contract. Names no Web Audio type; verified mechanically, and every remaining textual hit for `AudioBuffer`/`AudioContext`/`GainNode`/`decodeAudioData` outside the implementation is prose in a doc comment.
- `DecodedAudioEngine.ts` — the only file permitted to name a Web Audio type.
- `index.ts` — `createAudioEngine()`, the seam.
- `playbackClock.ts`, `decodedSize.ts`, `emitter.ts` — pure, and therefore testable under the Node-only vitest setup, which has no DOM.

`getTrackFileUrl` → `fetch` → `decodeAudioData`, using W1-3's `fermata://track/<id>` protocol. CSP already permitted it (`connect-src fermata:`), so no config changed.

## How the WebCodecs swap lands (acceptance bullet 4)

A `WebCodecsAudioEngine implements AudioEngine` lands beside the current one, and `createAudioEngine` changes one return statement — or gains a condition on estimated decoded size, keeping whole-buffer decode for short tracks where it gives sample-accurate gapless for free. Nothing else moves: no UI file names a Web Audio type or either class. `LibraryView.vue` demonstrates this by holding only an `AudioEngine` handle.

## Three decisions worth knowing about

**`ended` means the track finished.** A source node's `onended` also fires on `stop()`, so teardown clears the handler *before* stopping. Without this, every pause and seek announces a finished track — inaudible in M1, and an auto-advancing queue in M2.

**Position is derived, never counted.** A counter maintained alongside the AudioContext clock drifts from what is audible. Source nodes are single-use, so seeking builds a fresh node rather than repositioning one.

**Volume ramps over 15ms.** Assigning `gain.value` steps the parameter inside one render quantum, which is audible as a click.

## One defect, found by writing the log line

`decodeAudioData` **detaches** the ArrayBuffer it is handed, so reading `byteLength` afterwards yields 0. The R1 log would have recorded every track as a zero-byte file with an infinite expansion ratio. Because those figures exist precisely to inform M2's threshold, the bug would have silently corrupted the evidence rather than announced itself. Fixed in `e59385d` by reading the length before decoding.

## Acceptance results — measured in the running app

| Check | Result |
|---|---|
| MP3, FLAC, OGG play, seek, accurate duration | Pass — **WAV** also works, beyond the three asked for |
| Volume click-free | Pass |
| Second track tears down the first | Pass — no overlap, no tail |
| Reviewer can describe the WebCodecs swap | Pass — see above |
| `ended` fires **only** at natural end | Pass — 4 pause/resume cycles and a post-end seek produced zero `ended`; one fired, at the true end |
| Finished track replays without re-decoding | Pass — post-`ended` seek resumed with no second decode, confirming `ended` ≠ `idle` |

Long FLACs (~15 min) have a **noticeable load delay** before playback starts. Not a regression — it is D2's whole-track decode behaving as designed — but it is a latency argument for streaming that is independent of memory, and M2 should weigh it alongside R1.

## R1 evidence — real figures

| Track | Encoded | Decoded | Ratio | Duration | Rate |
|---|---|---|---|---|---|
| 1097 | 30.7MiB | 59.4MiB | 1.9x | 162.1s | 48kHz |
| 2973 | 7.3MiB | 70.3MiB | 9.6x | 192.0s | 48kHz |
| 2980 | 5.0MiB | 70.3MiB | 13.9x | 192.0s | 48kHz |
| 2986 | 32.7MiB | 71.3MiB | 2.2x | 194.6s | 48kHz |
| 1106 | 36.9MiB | 76.1MiB | 2.1x | 207.9s | 48kHz |
| 1552 | 34.2MiB | 109.6MiB | 3.2x | 299.4s | 48kHz |
| **951** | 106.3MiB | **339.1MiB** | 3.2x | **926.0s** | 48kHz |

`estimateDecodedBytes` predicts these **exactly**, not approximately: 192.0s × 48000 × 2 × 4 = 70.31 MiB against 70.3MiB logged. The M2 guard's estimator is sound.

### Four findings that change M2's plan

**1. This library is 48kHz, not 44.1kHz.** Every figure in R1 assumes 44.1k. At 48k the same track costs ~10% more, so R1's 250MB and 600MB defaults were derived against the wrong base rate and should be re-derived.

**2. R1's per-track cap already trips on real content.** Track 951 decoded to 339.1MiB (~356MB) — a 15.4-minute FLAC the user actually played, not the hypothetical twenty-minute DJ mix. At 48kHz stereo the 250MB cap trips at roughly **11 minutes**, which in a FLAC collection means live sets, classical movements and prog. D2's stated revisit trigger is "R1's guard starts firing on ordinary listening rather than edge-case files" — this is evidence the trigger is closer than assumed. The 600MB total budget is also tight: two tracks the size of 951 come to ~711MB with current+next prefetch.

**3. Expansion ratio is useless for estimation — 1.9x to 13.9x observed.** Tracks 2973 and 2980 have *identical* decoded size (70.3MiB, both 192.0s) from 7.3MiB and 5.0MiB sources. This **contradicts the reasoning in `e94c5f0`'s commit message**, which supposed the ratio would let a guard price a track from file size. It will not. M2 must estimate from metadata — duration × rate × channels — which is the signature `estimateDecodedBytes` already takes.

**4. Decode latency, not just memory,** argues for streaming on long tracks. See above.

## Conflict between the card and the design document — unresolved, needs a decision

**R1 states its mitigation "must ship with D2, not after."** D2's implementation is this card, so read literally, the guard belonged here. The card says the opposite — M1 measures, M2 guards — and M2's scope confirms it owns "R1's memory guard and streaming fallback".

Followed the card, on the grounds that it is the more specific authority on this milestone and reasons about R1 explicitly. But **one of the two documents is currently wrong**, and this is a `/doc-refine` item rather than something to settle silently. Hedged by shipping `estimateDecodedBytes` now — tested against R1's own 105MB/400MB figures — so the guard arrives as a caller change rather than a rewrite.

## Deliberate additions beyond the listed scope

- **`statuschange` event.** The card named ended, time-update and error. A UI polling `status` misses the transition through `loading` on a fast decode, and would have no correct moment to flip the play button.
- **`ready` distinct from `paused`, `ended` distinct from `idle`.** Both show a play button, but only one means the user has heard any of this track, and a finished track is still loaded — which is what makes replay free. Both distinctions were exercised in testing.
- **`AudioEngineError` separate from `FermataError`.** Nothing on the IPC boundary can be `decode-failed` and nothing here can be `conflict`; one shared enum would make every handler switch over codes that cannot occur in its half of the app.
- **Error contract documented:** `load()` rejects *and* emits `error`, so a UI can subscribe once instead of wrapping every call site. The exception is `aborted` — superseding a load is normal control flow, so it rejects the stale promise without emitting.

## Temporary harness — W4-1 must delete this

`LibraryView.vue` gained a track list, play/pause, scrub, volume and event logging. The card's acceptance is behavioural and nothing in the app could drive the engine. It is commented as a W3-1 harness in the file. What should survive is the coupling it demonstrates: the view holds an `AudioEngine` from `createAudioEngine` and names no Web Audio type.

The engine is held in a **plain variable, not a `ref`** — Vue deep-proxies reactive state, and reading a `#private` field through a Proxy throws, so wrapping it would break the engine on its first getter. Worth knowing before W4-1 puts it in a store.

## Tests

25 new unit tests over the clock arithmetic, the emitter and R1's size estimation; 168 pass overall. `estimateDecodedBytes` is pinned against the design document's own 105MB and 400MB figures, so if it drifts, M2's cap stops meaning what it was chosen to mean. Both typechecks clean.

The Web Audio wiring itself is verified by hand in the running app, recorded above — there is no DOM in the test environment, and adding jsdom would not have supplied an AudioContext anyway.

## Not pushed

No git remote exists on this repository, so the four commits are local only. Same gap W1-3 and W6-1 record.
