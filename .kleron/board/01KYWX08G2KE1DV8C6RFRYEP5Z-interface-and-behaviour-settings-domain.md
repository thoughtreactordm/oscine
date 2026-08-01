---
taskId: 01KYWX08G2KE1DV8C6RFRYEP5Z
title: Interface and behaviour settings domain
status: in-review
priority: low
labels: []
workstream: W8
workstreamId: W8-11
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 38
created: '2026-07-31T20:14:12.992Z'
updated: '2026-08-01T17:11:39.663Z'
---
The domain that is nearly free once the registry exists, and that a poweruser will notice the absence of immediately.

## Keys

- Density and row height — must respect the virtualization contract; a row-height change has to invalidate the virtual list's measurements rather than quietly desync them. This is the one entry here that is not trivial.
- Duration, date and file-size formats.
- Double-click action on a track — play now, play next, add to queue, add to viewed playlist.
- Restore session on launch — open playlist tabs, viewed selection, scroll position.
- Confirm before removing tracks from a playlist, before deleting a playlist, before removing a root.
- Close to tray, minimise to tray, start minimised — the tray affordances, if a tray exists by then; drop them from this card rather than building a tray for them.

## Explicitly not here

Keyboard shortcuts. W8 does not own a keymap subsystem, and a settings page for a keymap that does not exist would be a page of nothing. See the workstream description — that gap is real and currently unowned.

## Done when

- Row height and density changes are correct against a virtualized list at scale, tested at the 100k target rather than on a short fixture.
- Restore-session settings integrate with the existing playlist session state (absorbed in W8-3) rather than adding a parallel mechanism.
- Every confirmation toggle actually gates its confirmation — a toggle that is read by nothing is worse than no toggle.

---

## What landed — 907d364

Eight new descriptors in `src/shared/settings/interface.ts`, and four hand-rolled
answers deleted: `TrackList` formatted `M:SS` and divided by 1024 twice while
labelling the result "MB", `PodcastShowPane` formatted `H:MM:SS` and a long date,
`PodcastsSidebar` a short one.

| Key | Scope | Default |
|---|---|---|
| `interface.trackActivation` | durable | `play` |
| `view.trackListDensity` | view | `default` |
| `interface.durationFormat` | durable | `auto` |
| `interface.dateFormat` | durable | `medium` |
| `interface.fileSizeFormat` | durable | `binary` |
| `view.restoreSession` | view | `true` |
| `interface.confirmPlaylistDelete` | durable | `true` |
| `interface.confirmEntryRemoval` | durable | `true` |

New modules, all pure and `@shared`-only so they test under plain Node:
`panels/displayFormat.ts` (the four formatters, the density table, and
`createDisplayFormats`), `panels/trackActivation.ts` (the four verbs),
`settings/session.ts` (the launch gate). Their wiring is
`stores/displayFormat.ts` and `panels/useTrackActivation.ts` — a composable
rather than a store, because `playNow` differs per surface and a Pinia store
takes no arguments.

### The two scopes are not a coin toss

`view.trackListDensity` is view-scoped because it is *geometry the shell paints
with*: the view half reads synchronously and the durable half arrives on a
promise, so a durable row height would draw the whole list at one size and re-lay
it out at another. `view.restoreSession` is view-scoped because of *when* it is
read — `usePlaylistsStore` and `usePodcastsStore` decide whether to restore while
they are being constructed, and a gate that answered "I do not know yet" would
open on an empty strip and fill it a tick later. The rest are durable, so W8-13's
export carries them.

### Density, which is the entry that is not data entry

TanStack memoizes `getMeasurements` on `[count, paddingStart, scrollMargin,
getItemKey, enabled, lanes, laneAssignmentMode, gap]` plus a cache version only
`measure()` bumps. `estimateSize` is read *inside* that memo rather than being
one of its dependencies, and Nuxt UI's table never calls `measureElement` and
exposes only `$el` and `tableApi` — so there is no `measure()` to reach. A
density change would repaint every row at the new height while the virtualizer
went on placing them at the old one.

**Keying the table on its geometry remounts it**, and a fresh virtualizer has no
measurements to be stale. Guaranteed by Vue's own semantics rather than by a
dependency's memo list, which is the point: passing a fresh `getItemKey`
identity — which *is* one of those dependencies — works today and would fail
silently on the upgrade that reorders them, and silent is the failure being
prevented. **The album header height is in that key too**: it has been changeable
since W8-3 gave art size a control, and it has had this same bug that whole time.

`displayTopPx` and `displayAtPx` joined `trackGrouping.ts`, beside the
`headersBefore` whose doc comment already framed this as pixel arithmetic. The
inverse is a binary search rather than a division because two row heights make
the offset piecewise linear — seventeen steps at the 100k target.

**The scroll memory now holds a display row, not a pixel offset.** The live run
found this: the operator changes the height on the *Settings* tab, which unmounts
the list, so the in-component geometry watcher never sees it and the remembered
offset is handed back at a height it no longer describes. A row survives it, and
survives an album-header resize and a grouping toggle with it. `ScrollMemory`
stays an incurious LRU of one number per key — it owns the eviction, not the
unit.

### Decisions worth knowing

- **`auto` is the default duration format, not `minutes`.** `minutes` is what the
  track list did and it renders a 94-minute mix as `94:00`; `auto` is what
  `PodcastShowPane` already did, so half the app was already right.
- **Binary sizes, and the units now say so.** Dividing by 1024 twice and printing
  "MB" is a mebibyte wearing a megabyte's name — the kind of thing the operator
  this app is for notices. Both answers are offered; only one is printed.
- **`addToViewedPlaylist` falls back to playing when no playlist is open.** Doing
  nothing on the most-used gesture in the app is indistinguishable from a hang.
  `hint` says so where a surface has room.
- **The confirmation toggle is off means off**, including for the playing
  playlist. Half-honouring it would leave the operator who turned it off still
  being asked, at the moment they least expect it, about the case they can hear.
- **The restore gate is a read and nothing else.** The strips go on recording
  through the watcher they always used, so a launch with the gate shut opens
  empty and then records "empty" — turning the setting back on reopens what was
  genuinely last open. Suppressing the write too would restore a session from
  before the setting was ever touched. An earlier draft claimed the opposite in a
  comment and the live run disproved it; the code was right and the comment was
  not.

### Dropped rather than built

- **The tray toggles.** There is no tray. The card says to drop them rather than
  build one for them.
- **Confirm before removing a root.** There is no `library.removeRoot` — no IPC
  channel, no store action, no affordance. A toggle gating an operation that does
  not exist is precisely the toggle read by nothing the card forbids. W8-10 owns
  root management and should add the key with the operation.
- **Scroll position across a launch.** `createScrollMemory` is an in-memory `Map`
  and is deliberately not persisted — its own comment says why. The tabs and the
  viewed selection restore; the offset was never available to restore.

### Done when — evidence

- **Density against a virtualized list at the 100k target** —
  `trackGrouping.test.ts` gains 6 tests including 10,000 albums of ten tracks
  (110,000 display rows), and every row round-tripping through a height change.
  Live, on a 100k synthetic library scrolled to row 60,000:

  | | scrollTop | scrollHeight | row |
  |---|---|---|---|
  | Default | 1,920,000 | 3,200,040 | 32 |
  | Compact | 1,440,000 | 2,400,040 | 24 |
  | Roomy | 2,400,000 | 4,000,048 | 40 |
  | Default | 1,920,000 | 3,200,040 | 32 |

  `scrollHeight` tracking the height is the invalidation: without the key it
  would have stayed at 3,200,040 while the rows drew at 24. The top row —
  `Juniper Bloom 88044` — was the same one throughout.
- **Restore-session integrates rather than duplicating** — `session.test.ts` (5
  tests) plus two live relaunches: with the gate open, tabs `[1, 2]` viewing `2`
  came back; with it shut, the same profile opened on `[]`.
- **Every confirmation toggle gates its confirmation** —
  `playlistRail.test.ts` (3 new) and `playlistContents.test.ts` (7 new). Live:
  deleting a playlist with 3 entries raised `Delete "Full"? Its 3 entries go with
  it.` with the toggle on and Keep preserved it, and deleted outright with it
  off; removing an entry raised the prompt from the row menu (12 → Keep → 12 →
  Remove → 11) and went straight through with the toggle off (→ 10).
  **The album-header menu was bypassing the gate** — it called
  `entries.removeEntries` directly, which would have made this a toggle that
  stopped half the removals. Now `model.removeEntries`, verified live raising the
  prompt from that menu.
- `lint`, `format:check`, `typecheck`, `test` (87 files, 1358 tests) and `build`
  all clean.

### The live run

Second instance against a throwaway user-data directory seeded with 100,000
synthetic tracks, driven over CDP on 9337.

- All eleven Interface rows render in order with the right controls and defaults,
  and the deep link reaches the last of them.
- Duration and size change in the list as the setting changes: `2:12` →
  `0:02:12` under `hours`, `13 MiB` → `14 MB` under `decimal`.
- Double-click queued instead of playing under `queue` (user queue 0 → 1) and
  inserted at the head under `playNext` (1 → 2).
- The `view.restoreSession` switch writes `{value, version}` both ways.
- Reka's context menu and dropdown need the full CDP pointer sequence —
  `mouseMoved`, then `mousePressed`/`mouseReleased` with `buttons` set. A DOM
  `MouseEvent('contextmenu')` never reaches them, which is the same finding W8-6
  recorded for the select. The album-header button also has to be
  `scrollIntoView`'d first: the table scrolls horizontally and it sits past the
  viewport edge.

### Left for the cards that own them

- **Keyboard shortcuts** stay absent. W8 does not own a keymap subsystem.
- **Root-removal confirmation** belongs with W8-10's root management.
- **Export** — W8-13. Every key here is durable-or-view by a stated argument, so
  the portable/machine-local split has something to read.
