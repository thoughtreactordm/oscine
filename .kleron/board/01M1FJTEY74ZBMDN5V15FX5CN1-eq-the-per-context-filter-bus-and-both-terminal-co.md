---
taskId: 01M1FJTEY74ZBMDN5V15FX5CN1
title: 'EQ: the per-context filter bus and both terminal connections'
status: backlog
priority: high
labels:
  - eq
  - audio
  - renderer
  - D30
workstream: W19
workstreamId: W19-1
order: 23
created: '2026-09-01T22:53:15.078Z'
updated: '2026-09-01T22:53:15.078Z'
---
## Intent

The foundation card: a filter chain per `AudioContext`, a router that keeps every live chain
pointed at the same desired settings, and the two edits that move the graph's terminal connection
through it. No settings, no presets, no UI — this card ends at a tested `EqualizerRouter` and an
app whose audio still sounds identical because the default spec is flat.

## D30, and why the placement is forced

There is no master bus in this app. The graph terminates in two places:

- `DecodedAudioEngine.ts:92` — `this.#gain.connect(this.#context.destination)`
- `browserStreamingPlatform.ts` — `masterGain.connect(context.destination)`

and up to three contexts are live at once: `DecodedAudioContextPool` hands one pooled context to
both scheduler slots so their clocks agree, and each `StreamingAudioEngine` builds its own.

Three placements were considered and two fail on the graph as built:

- **Per engine** — the two decoded slots each get a chain. During a crossfade that is twice the
  biquads and two parameter targets to keep in sync, for no benefit; the slots share a context and
  therefore share a mix point already.
- **Per track**, beside `normalizationGain` / `transitionGain` (`DecodedAudioEngine.ts:493-494`) —
  those nodes are built and torn down on every track, so the whole chain would be rebuilt mid-stream
  at every gapless boundary. This is the worst of the three.
- **Per context** — one chain between the master gains and `destination`. Survives crossfade
  (post-mix by construction), survives gapless (nothing is rebuilt), and matches how the sink is
  already handled.

## Copy AudioOutputRouter, deliberately

`outputDevice.ts` already solved this exact shape and says so: "one desired device, applied to every
live context, and applied again to each new one as it is created." Copy the properties:

- A narrow context interface — `BiquadCapableContext`, the peer of `SinkCapableContext` — so the
  router unit-tests with no Web Audio at all. This is the property that makes W19-2..W19-5
  testable in CI.
- `#prune()` on closed contexts. The pool closes its context when the last lease releases and each
  streaming platform closes its own; neither tells this router and neither should have to.
- Failures are reported, never thrown — one context failing must not leave the others on a stale
  spec.

## Contract

`src/renderer/audio/equalizer.ts`:

```ts
export interface EqualizerBand {
  id: string                     // stable; survives reorder, and is what W19-6 would reference
  type: 'peaking' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'notch'
  frequencyHz: number            // clamped 20 .. min(20000, nyquist)
  gainDb: number                 // clamped ±24; ignored by lowpass/highpass/notch
  q: number                      // clamped 0.1 .. 18
  enabled: boolean
}
export interface EqualizerSpec {
  enabled: boolean
  preampDb: number
  bands: readonly EqualizerBand[]
}
export const EQUALIZER_BAND_LIMIT = 12
export const FLAT_EQUALIZER_SPEC: EqualizerSpec

export class EqualizerRouter {
  attach(context: BiquadCapableContext): AudioNode   // returns the node to connect INTO
  setSpec(spec: EqualizerSpec): void                 // applies to every live chain
  readonly spec: EqualizerSpec
}
```

`attach()` returns the chain's input. Clamping lives here and not only in the settings validator,
because the router is what protects the audio device — a `frequencyHz` above Nyquist makes a biquad
produce NaN, and NaN in a Web Audio graph is silence until the context is rebuilt.

## Chain shape

```
input → preamp → [12 biquads, serial] → wet ─┐
      └───────────────────────────────── dry ┴→ output → destination
```

- **Fixed pool of 12**, allocated once in `attach()`. Unused bands are parked as `peaking, 0 dB,
  Q 1` — inaudible, and adding or removing a band never touches a running graph.
- **Dry/wet pair** rather than reconnecting for bypass. Ramping between them over `VOLUME_RAMP_SEC`
  (0.015, the constant both paths already use for volume) gives click-free enable/disable and A/B
  compare for free; disconnecting a live node gives a click.
- `enabled: false` on the spec ramps to dry. It does **not** tear the chain down — a bypassed EQ
  costs one silent gain node and a rebuild costs a click.

## Ramping is not optional

Every parameter change uses `setTargetAtTime` with a ~10 ms time constant on `frequency`, `gain`
and `Q`. A raw `.value =` assignment while an operator drags a handle produces audible zipper noise,
and W19-4 drags handles at pointer-move rate. This is the single most likely defect in the stream
to reach a release, because no automated test hears it — hence W19-7.

Filter `type` cannot be ramped; it is a discrete swap. Accept the transient, and note in a comment
that type changes are expected to be rare and operator-initiated.

## The two terminal edits

**Decoded.** `DecodedAudioContextPool` already hands out `{ context, timeline, release }`; add
`destination: AudioNode`, populated by the router at context creation. `DecodedAudioEngine.ts:92`
becomes `this.#gain.connect(this.#contextLease.destination)`. That is the entire change to the
engine, and it never learns the EQ exists — which is what keeps `AudioEngine` and `AudioPath`
untouched.

**Streaming.** `BrowserStreamingPlatformOptions` already carries an `adoptContext` hook for exactly
this class of concern; give it a `resolveDestination?: (context: AudioContext) => AudioNode`
sibling, defaulting to `context.destination` so a platform built without it still plays (which is
what the existing tests want).

**Both, in this card.** Wiring only the decoded path ships an EQ that silently vanishes on whatever
R1 sent to `<audio>` — the long tracks, the ones an operator is most likely to be listening
carefully to. That is an unreproducible bug report, not a follow-up.

Leave the analyser tap where it is (`transitionGain → #analyser`, pre-master). The waveform ribbon
is about the track, not about the EQ, and the comment at `browserStreamingPlatform.ts` explaining
why the tap sits ahead of master volume applies unchanged.

## Wiring

`createAudioEngineFactory` in `audio/index.ts` constructs the `EqualizerRouter` beside the
`AudioOutputRouter`, passes it into the pool's context factory and the streaming platform options,
and `AudioEngineFactory` grows `setEqualizer(spec)` next to `setOutputDevice`. Same reasoning as the
comment already in `outputDevice.ts`: this is a fact about the contexts the factory builds, not
about a slot.

## Files

- `src/renderer/audio/equalizer.ts` — band/spec types, `EqualizerRouter`, clamps
- `src/renderer/audio/decodedAudioContext.ts` — `destination` on the lease
- `src/renderer/audio/DecodedAudioEngine.ts` — one line at 92
- `src/renderer/audio/browserStreamingPlatform.ts` — `resolveDestination`
- `src/renderer/audio/index.ts` — construction and the `setEqualizer` export

## Tests

`tests/renderer/audio/equalizer.test.ts`, against a fake `BiquadCapableContext` that records node
creation, connections and scheduled param calls:

- `attach()` builds exactly 12 biquads plus preamp, dry, wet and output, and returns the input.
- The connection graph is the shape above; the output reaches `destination` exactly once.
- A spec with 3 bands leaves 9 parked at `peaking, 0 dB` — assert the parked values, since a parked
  band left at a stale gain is an audible bug.
- Adding and removing a band creates and destroys **no** nodes.
- Every parameter write goes through `setTargetAtTime`; assert no direct `.value` assignment on
  `frequency`, `gain` or `Q` after construction. This is the regression test for zipper noise.
- Out-of-range values are clamped, and a frequency above Nyquist is clamped rather than passed
  through.
- `setSpec` reaches every attached context, including one attached afterwards.
- A closed context is pruned and a later `setSpec` does not touch it.
- One context throwing does not prevent the others being updated.
- The default spec is flat and `enabled: false`, so this card changes nothing audible.

## Out of scope

No settings keys, no persistence, no presets, no UI, no curve maths, no preamp automation. The
spec arrives through `setEqualizer` and nothing calls it yet.
