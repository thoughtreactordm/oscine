---
taskId: 01M1FJVCQN5B4BZKETP8H0DDQC
title: 'EQ: the response curve as pure maths, tested against Web Audio'
status: backlog
priority: medium
labels:
  - eq
  - dsp
  - pure
  - tests
workstream: W19
workstreamId: W19-2
order: 24
created: '2026-09-01T22:53:45.588Z'
updated: '2026-09-01T22:53:45.588Z'
---
## Intent

The magnitude response of a band, and of a whole spec, as pure functions over numbers. This is what
W19-4 draws. No nodes, no context, no Vue — so it can be built in parallel with W19-1 and it is the
easiest card in the stream to get provably right.

## Why not `getFrequencyResponse()`

`BiquadFilterNode.getFrequencyResponse()` is right there and it is still the wrong source for the
drawn curve. It requires a live node in a live context, which means the curve cannot be tested
without Web Audio, cannot be drawn before the context exists (the pane opens before playback
starts), and would have to be re-read on every drag frame from a node the audio thread is also
reading.

A pure implementation is the shape the rest of this directory already has — `equalPower.ts`,
`gaplessTiming.ts`, `normalization.ts` are all pure and all unit-tested — and it lets the agreement
between picture and sound be asserted **once, as a test**, rather than assumed on every frame.

## Contract

`src/renderer/audio/eqResponse.ts`:

- `biquadCoefficients(band: EqualizerBand, sampleRateHz: number): BiquadCoefficients` —
  `{ b0, b1, b2, a1, a2 }`, normalised by `a0`, from the RBJ Audio EQ Cookbook formulae.
- `bandMagnitudeDb(coefficients, frequencyHz, sampleRateHz): number`
- `specMagnitudeDb(spec: EqualizerSpec, frequencyHz, sampleRateHz): number` — the composite
- `responseCurveDb(spec, sampleRateHz, points: number, minHz, maxHz): Float32Array` — the whole
  curve on a log-spaced grid, which is what the pane calls per redraw
- `logFrequencyAt(fraction, minHz, maxHz)` / `fractionForFrequency(...)` — the x-axis mapping, kept
  here rather than in the component so the pane's hit-testing and the curve cannot disagree

Two properties make the composite cheap and correct: magnitudes multiply, so **decibels add** —
the composite is the sum of the per-band dB curves plus `preampDb`, with disabled bands and
`enabled: false` contributing nothing. And the per-band curves are what the pane needs to draw
individually anyway, so nothing is computed twice.

Evaluate |H(e^jω)| directly rather than reconstructing it from the filter's parameters; the
cookbook's shelf and peaking forms diverge from the naive "gain at centre frequency" intuition
at low Q, and drawing the intuition instead of the transfer function is the classic way for a
curve to lie.

## Sample rate

The curve depends on sample rate — a peaking band at 18 kHz looks different at 44.1 kHz and 96 kHz,
and the cookbook's bilinear-transform warping is why. Take it as a parameter; do not hardcode
44100. The pane gets it from the live context via W19-1 (`DecodedAudioPath` already exposes
`targetSampleRateHz`), and falls back to 48000 when nothing is playing yet, stated in a comment
rather than left as a magic number.

## Tests

`tests/renderer/audio/eqResponse.test.ts`:

- **The agreement test.** For a spread of bands across every filter type, assert
  `bandMagnitudeDb` matches a real `BiquadFilterNode.getFrequencyResponse()` within ~0.01 dB across
  a log sweep. This is the one test in the stream that proves the picture matches the sound, and it
  is the reason a pure implementation is safe. Skip it cleanly where the runtime has no Web Audio
  rather than letting it fail the suite.
- A flat spec is 0 dB everywhere; a disabled spec is 0 dB everywhere regardless of its bands.
- A peaking band's maximum is at its centre frequency and equals its `gainDb` (this holds for
  peaking; assert the shelves against the cookbook instead, where midpoint gain is `gainDb / 2`).
- Two identical +6 dB bands compose to +12 dB at centre — the dB-addition property, asserted
  directly.
- `preampDb` offsets the whole curve.
- Q affects width, not peak height, for peaking bands.
- Low-pass and high-pass ignore `gainDb` entirely, and their −3 dB point sits at the cutoff for
  Q = 1/√2.
- Sample rate changes the high-frequency end (same band at 44.1 vs 96 kHz differs above ~15 kHz).
- No NaN or Infinity anywhere across the clamp ranges W19-1 defines, including the extremes of Q
  and a frequency at exactly Nyquist. A NaN here paints a broken curve; the same NaN reaching a
  node silences the context.
- `logFrequencyAt` and `fractionForFrequency` round-trip.

## Out of scope

No phase response — the pane draws magnitude only, and phase is not a thing an operator of this
feature acts on. No group delay. No drawing, no SVG, no component. No filter types beyond the six
in `EqualizerBand`.
