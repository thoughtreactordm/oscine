---
taskId: 01KYWWX4982WY57N4AYGJGXRJR
title: Reactive settings store and live propagation
status: in-progress
priority: high
labels: []
workstream: W8
workstreamId: W8-4
dependsOn:
  - 01KYWWWA83W72X3CAT388JY932
  - 01KYWWWM5AMXSSMHVXN6G86VT2
order: 7
created: '2026-07-31T20:12:30.375Z'
updated: '2026-08-01T04:14:45.919Z'
---
Settings apply immediately, everywhere, with no OK/Cancel and no staging buffer. Changing crossfade mid-track changes the next boundary. Changing a theme token repaints. Per-setting revert (W8-7) is the undo.

This is the card that makes the other decision expensive if skipped: without it, "apply immediately" degrades to "applies next launch", which reads as broken.

## Shape

A Pinia store over both backends, presenting one flat reactive surface keyed by the registry. Consumers read reactively — `computed`/`watch` — rather than snapshotting at init. The `durable` half hydrates from `settings.getAll` at startup; the `view` half reads synchronously so the shell can paint its own layout without waiting on IPC.

Writes go out optimistically and are reconciled against main's validated response. Persistence is debounced; propagation is not.

## Propagation

- Renderer to main: `settings.set`.
- Main to renderer: the `settings.changed` broadcast, so a value main changed (or another window changed) lands without a poll.
- Within the renderer: reactivity does the rest.

The loop must not oscillate — a change originating in the renderer, echoed back by `settings.changed`, must settle rather than re-emit. Test this explicitly; it is the obvious bug.

## requiresRestart

Keys flagged `requiresRestart` in the registry persist immediately but show a badge and do not pretend to have taken effect. The flag is presentation only — the store does not special-case them.

## Consumer conversion

At least two real consumers convert as proof: the audio engine's crossfade/gapless values and the transport preferences. A consumer that still snapshots at init is a failed conversion.

## Done when

- `tests/renderer/stores/settings.test.ts` covers hydration, optimistic write and reconcile, broadcast-in without echo-out, debounce, and validation rejection surfacing to the caller.
- A crossfade change is audible at the next boundary without a restart, verified in the running app.
- `requiresRestart` badges render from the flag, not from a hardcoded list.
