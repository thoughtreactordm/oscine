---
taskId: 01KYQAPNHCVJFAZKAJMMNNRB4W
title: ReplayGain contract and per-track normalization
status: todo
priority: high
labels:
  - M2
  - audio
  - ReplayGain
  - normalization
workstream: W3
workstreamId: W3-9
dependsOn:
  - 01KYQAMF536T5PFR2GEXJ7PFYT
effort: high
order: 4
created: '2026-07-29T16:18:12.140Z'
updated: '2026-07-29T16:18:12.140Z'
---
Carry the ReplayGain values already captured at scan time across the typed boundary and apply them in the audio graph without coupling normalization to master volume or transition fades.

## Scope

- Extend the shared track/playback contract with nullable track gain/peak, album gain/peak and `rg_source`, while continuing to expose no filesystem path.
- Define one explicit normalization policy: `off`, `track` and `album`, with track mode as the M2 default. Album mode uses album values when present and falls back to track values; absent gain means unity until computation supplies a value.
- Convert gain in decibels to linear amplitude with `10^(dB/20)`. Use the corresponding stored peak to prevent known clipping; malformed/non-finite values must never reach an AudioParam.
- Give every scheduled source a normalization-gain stage distinct from its transition-gain stage and the master-volume stage. The graph must compose ReplayGain, crossfade and user volume without one feature overwriting another's automation.
- Apply the gain before a source becomes audible. Mode changes during playback use a short ramp rather than a parameter step.
- Preserve whether the value came from a tag or computation for diagnostics and later UI, but apply both sources identically.
- Pin scanner/rescan policy: a scan with ReplayGain tags may replace a computed value; a scan with no tags must preserve an existing `rg_source = 'computed'` result rather than erase it.

## Acceptance

- Unit tests cover dB-to-linear conversion, positive and negative gain, peak limiting, partial tag sets, album-to-track fallback, disabled mode, and malformed values.
- Graph tests prove ReplayGain automation does not overwrite crossfade envelopes or master volume.
- A tagged fixture produces the expected effective gain in the running app, with the chosen field and `rg_source` visible in structured diagnostics.
- Re-scanning an untagged file preserves computed gain; adding real tags later replaces it with `rg_source = 'tag'`.
- Tracks without a value play at unity and are eligible for the compute-when-missing job rather than being treated as errors.

## Non-goals

No loudness analysis in this card. It consumes values already in SQLite; the background compute card produces missing ones.
