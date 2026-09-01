---
taskId: 01M1FJWETAJMAMQ5VE07A2J9QP
title: 'EQ: settings keys, named presets, and the push down to the graph'
status: backlog
priority: medium
labels:
  - eq
  - settings
  - persistence
  - W8
workstream: W19
workstreamId: W19-3
dependsOn:
  - 01M1FJTEY74ZBMDN5V15FX5CN1
order: 25
created: '2026-09-01T22:54:20.490Z'
updated: '2026-09-01T22:54:20.490Z'
---
## Intent

Where the EQ state lives, how presets are saved and recalled, and the wire from a settings change to
the filter chain. After this card the EQ is fully functional with no UI — set the value through the
settings store in a test and the audio changes.

## Three durable keys, no migration

In `src/shared/settings/audio.ts`, beside `audio.replayGainMode` and friends, so they ride W8's
cascade and land in D11's export bundle for free:

- `audio.eq.enabled` — boolean, default `false`
- `audio.eq.active` — the live `EqualizerSpec`, default flat
- `audio.eq.presets` — `EqualizerPreset[]`, default `[]`

**A validated JSON blob, not a table.** `theme.overrides` (W8-12) is the precedent: a validated map
in one durable key. Playlists are SQL because of entry cardinality — a preset is at most twelve
bands of four numbers and a handful of presets, never queried, never joined. A migration here would
be schema for the sake of it.

The validators are the load-bearing part, because a hand-edited or version-skewed blob reaches an
audio graph. Reject rather than coerce on structure (wrong shape ⇒ fall back to the descriptor
default), clamp rather than reject on range (a `gainDb` of 400 becomes 24), and cap the array at
`EQUALIZER_BAND_LIMIT`. W19-1 clamps again at the router; both are correct and neither is
redundant — the settings layer protects the stored value, the router protects the device.

Set `version: 1` and write the descriptors expecting an `upgrade`, since the band model is the thing
most likely to grow a field.

## Preset ids are the forward-compatibility move

```ts
export interface EqualizerPreset {
  id: string        // stable, generated once, never derived from the name
  name: string
  spec: EqualizerSpec
}
```

The `prospective-ideas` entry this stream promotes reads: "Assign Genres, Artists, Albums, or
Playlists to EQ presets and they will automatically adapt to use their assigned profile." The moment
that lands (W19-6), a preset stops being a value and becomes a **referenced entity**. Give it a
stable id now and that follow-on is one new cascading key with zero data migration; skip it and it
is a blob migration to add identity to records that already exist in operators' installs.

Renaming a preset must not break a reference, which is exactly why the id is not the name.

Duplicate names are allowed but flagged in the UI, not rejected — an operator with two "Car" presets
has made a mess, not an error, and refusing the write mid-session loses their work.

## The push path — copy outputDevice, not normalizationPolicy

The EQ is a context property, so it goes around the scheduler rather than through it. Three edits,
each mirroring an existing line:

1. `playback/audioPreferences.ts` — add `equalizer: ComputedRef<EqualizerSpec>` derived from
   `audio.eq.enabled` and `audio.eq.active`, named here once like every other key.
2. `playback/controller.ts` — `watch(audioPreferences.equalizer, spec => deps.setEqualizer?.(spec))`,
   `immediate: true`, sitting directly beside the existing `outputDevice` watcher that calls
   `deps.setOutputDevice?.()`. Same optional-callback shape, same disposal.
3. Wherever the controller's deps are constructed — pass the factory's `setEqualizer` through.

Do **not** add a method to `AudioEngine`, `AudioPath` or `PlaybackScheduler`. A slot engine that
could set the EQ would be an engine that can fight the other slot for it, which is the failure D30
exists to prevent.

Recall is a plain assignment: applying a preset writes `audio.eq.active` and the watcher does the
rest. There is no separate "apply" path to keep in sync, and no staged state — settings in this app
apply immediately and broadcast, and the EQ has no reason to be the exception.

## Store

`src/renderer/stores/equalizer.ts` — the pane's state and the preset CRUD: `savePreset(name)`,
`applyPreset(id)`, `renamePreset(id, name)`, `deletePreset(id)`, plus a `dirty` flag comparing the
active spec against the applied preset so the pane can show "Bass boost (modified)". Preset CRUD
writes the settings key; nothing else in the app writes it.

## Files

- `src/shared/settings/audio.ts` — the three descriptors and their validators
- `src/shared/audio/equalizer.ts` (or the existing shared audio types module) — `EqualizerPreset`,
  if `EqualizerSpec` needs to be visible to `src/shared`; keep the router in the renderer either way
- `src/renderer/playback/audioPreferences.ts`, `controller.ts`
- `src/renderer/stores/equalizer.ts`

## Tests

- Each validator: a well-formed spec passes; a missing field, a wrong type, a 13-band array and a
  non-array all fall back to the default rather than throwing into the settings load path.
- Out-of-range numbers clamp; NaN and Infinity are rejected outright, not clamped.
- Preset round-trip through the settings store preserves ids.
- Renaming a preset preserves its id; deleting one leaves the others' ids untouched.
- Duplicate names are permitted and both survive a reload.
- `applyPreset` writes `audio.eq.active` and the controller's watcher fires `setEqualizer` once with
  that spec — assert against a fake, this is the seam.
- `audio.eq.enabled: false` reaches the router as `enabled: false` rather than as an empty band
  list. The distinction matters: an empty list is a flat EQ still in circuit, and W19-5's clip
  indicator reads it.
- The watcher is disposed with the controller, and no `setEqualizer` fires afterwards.

## Out of scope

No UI. No per-entity assignment (W19-6) — this card only makes it cheap. No import or export of
foreign preset formats. No preset sharing, no bundled factory presets: an EQ that ships with a
"Rock" curve is guessing about speakers it cannot see.
