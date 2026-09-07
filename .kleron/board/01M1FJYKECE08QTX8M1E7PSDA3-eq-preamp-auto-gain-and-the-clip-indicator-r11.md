---
taskId: 01M1FJYKECE08QTX8M1E7PSDA3
title: 'EQ: preamp, auto-gain and the clip indicator (R11)'
status: backlog
priority: high
labels:
  - eq
  - audio
  - R11
  - headroom
workstream: W19
workstreamId: W19-5
dependsOn:
  - 01M1FJVCQN5B4BZKETP8H0DDQC
  - 01M1FJXM0N7Q7RQV88PQ3CHV03
order: 29
created: '2026-09-01T22:55:30.763Z'
updated: '2026-09-01T22:55:30.763Z'
---
## Intent

Stop the EQ from making the app sound worse the first time it is used. R11 in one card: a preamp
the operator can set, an auto-set that computes the right value, and an indicator that says when
the output is clipping.

## Why this is high priority and not polish

The chain sits after ReplayGain. An operator who boosts 80 Hz by 6 dB on a modern loudness-war
master is asking for samples above full scale, and the DAC's answer is hard clipping — a crunch on
every kick. They will not attribute it to the EQ; they will attribute it to the app.

This is R1's discipline applied to a different mechanism: **the mitigation ships with the thing it
mitigates.** A boost control without headroom management is a feature that damages its own first
impression.

Note that master volume does not save you. The graph is linear up to the destination, so attenuation
after a boost is arithmetically identical to no boost — but the operator listening at low volume
still clips, because the clip happens at the device, and the master gain is upstream of nothing that
would prevent it.

## Preamp

`EqualizerSpec.preampDb` already exists from W19-1 and is already the first node in the chain. This
card gives it a control: a slider plus numeric entry in the pane's preset bar, −24 to +12 dB,
default 0.

## Auto-set

A button that sets `preampDb` to the negative of the composite curve's maximum, clamped at 0 (never
boost automatically), computed from W19-2's `responseCurveDb` over the whole grid — not from the
maximum band gain, which is wrong whenever two bands overlap and add.

Explicitly **a button, not a mode.** Continuous auto-gain would move the level under the operator
while they drag, making it impossible to judge what a band is doing, which is the one thing the
surface exists for. Recompute the suggestion live and show it on the button ("Auto: −7.4 dB") so
the operator can see what it would do before doing it.

## Clip indicator

An `AnalyserNode` after the chain's output, polled on `requestAnimationFrame` **only while the pane
is visible** — do not add a permanent poll for an indicator nobody is looking at. Read the
time-domain data, flag when any sample is ≥ 0.999, latch the indicator for ~1.5 s so a transient is
actually seen, and offer a click to clear.

`readWaveform` and the existing analysers are the precedent for the tap; add this one in
`EqualizerRouter`, since the node it hangs off belongs to the chain. Attach the analyser lazily on
first subscription and detach on the last, so an operator who never opens the pane pays nothing.

The indicator must be honest about what it can see: it observes the EQ output, not the device, so
label it as clipping in the EQ rather than as clipping in general. A vague indicator that is
sometimes wrong is worse than a specific one that is always right about a narrower thing.

## Deliberately not a limiter

A `DynamicsCompressorNode` on the output would prevent clipping and would also be the first
nonlinear stage in the app's audio path — it changes the sound of everything, it has its own
parameters to get wrong, and it makes the drawn curve stop describing the output. A format-first
player does not silently compress. Preamp plus an honest indicator keeps the path linear and leaves
the decision with the operator.

Record that as the settled position so it is not relitigated by the next person who sees a clip
light.

## Files

- `src/renderer/audio/equalizer.ts` — the output analyser tap, lazy attach/detach
- `src/renderer/audio/eqResponse.ts` — `suggestedPreampDb(spec, sampleRateHz)`, pure
- `src/renderer/panels/tools/EqualizerTool.vue` — the preamp control, Auto button, clip light
- `src/renderer/stores/equalizer.ts` — indicator state and the poll lifecycle

## Tests

- `suggestedPreampDb` returns 0 for a flat or cutting-only spec, and the exact negative of the
  composite maximum for a boosting one.
- Two overlapping +4 dB bands suggest more than −4 dB — the case a max-band-gain implementation gets
  wrong, asserted directly.
- The suggestion accounts for the current `preampDb` rather than compounding with it (pressing Auto
  twice is idempotent).
- The clip detector fires on a synthetic buffer containing one sample at 1.0 and does not fire at
  0.99.
- The latch holds for the stated duration and clears on click.
- The analyser is attached on first subscription and **detached when the pane unmounts** — a leaked
  rAF poll is the likely defect here, the same shape as W18-7's leaked interval.
- With no subscriber, the router creates no analyser at all.

## Out of scope

No limiter, no compressor, no soft clipper. No per-track or per-album automatic gain. No true-peak
(inter-sample) detection — it needs oversampling and it would be measuring a problem the operator
cannot act on differently.
