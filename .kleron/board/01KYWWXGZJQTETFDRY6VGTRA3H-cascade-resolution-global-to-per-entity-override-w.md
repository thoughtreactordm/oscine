---
taskId: 01KYWWXGZJQTETFDRY6VGTRA3H
title: 'Cascade resolution — global to per-entity override, with provenance'
status: done
priority: medium
labels: []
workstream: W8
workstreamId: W8-5
dependsOn:
  - 01KYWWVQQB80JQ6KK80HX96KYN
  - 01KYWWWA83W72X3CAT388JY932
order: 10
created: '2026-07-31T20:12:43.376Z'
updated: '2026-08-02T13:14:31.190Z'
---
One resolution path for every "this playlist plays differently" case, replacing the ad-hoc ones.

Fermata already ships an override: `playlists.setCrossfade` is a per-playlist audio value living in its own column with its own IPC channel. That pattern will recur — per-root scan rules, per-view column layouts, per-playlist playback behaviour — and reinventing it each time means reinventing the "is this inherited or set here?" affordance each time too.

## Resolution

`descriptor.default` → `global` row → entity override row. First value found wins, walking from most specific. A key participates only if its descriptor declares `cascade`, naming the entity kinds it accepts; asking for an override on a non-cascading key is a type error, not a runtime one.

Resolution returns **value plus provenance** — which level supplied it — because the UI cannot render the override affordance without knowing. That is the whole reason this is a card and not a `??` chain.

## UI contract

Any control bound to a cascading key in an entity context renders three states: inheriting (shows the inherited value, greyed, with the source named), overridden here (shows the local value with a revert-to-inherited control), and set-at-this-level-and-equal-to-inherited (still an override — do not collapse it silently, or the operator's explicit choice vanishes when the global changes).

## Folding in crossfade

`playlists.setCrossfade` and its column become an override row on `audio.crossfadeMs`. The existing IPC channel either forwards to `settings.set` or is retired; either way the playlist table stops carrying its own settings column. Migrate existing per-playlist crossfade values — an operator who set one keeps it.

Guard the invariant on the way through: gapless and crossfade are mutually exclusive per boundary, and an override must not be able to violate it at a level the global check does not see.

## Done when

- Resolution and provenance are unit-tested across all three levels including the equal-to-inherited case.
- Existing per-playlist crossfade values survive the migration, proven by a fixture test.
- No table outside `settings` carries a settings column.
