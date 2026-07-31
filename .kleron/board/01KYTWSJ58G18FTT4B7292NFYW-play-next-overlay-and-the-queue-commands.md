---
taskId: 01KYTWSJ58G18FTT4B7292NFYW
title: Play-next overlay and the queue commands
status: in-review
priority: high
labels:
  - M4
  - ui
workstream: W5
workstreamId: W5-7
dependsOn:
  - 01KYTWS0VXNMWQFQE9PC4X31CR
order: 26
created: '2026-07-31T01:32:04.646Z'
updated: '2026-07-31T03:45:10.960Z'
---
## Scope

- The queue commands, in one shared module: **Play next** and **Add to queue**, available from
  the library list, the playlist contents pane, and any multi-select in either.
- The overlay named in M4's scope: a compact popover over the transport listing what is queued,
  with remove, clear, and jump-to-entry. A queued-count indicator on the transport so a
  non-empty queue is never invisible.
- Reordering inside the overlay is optional here — the full editor is **W7-2** in M5.

## Acceptance

- The commands live in a module the Tunedeck up-next pane can import unchanged. W7-2 replaces
  this overlay's body with the deck pane; it must not have to reimplement the verbs.
- Queueing from a multi-select preserves the selection's visible order.
- The overlay is virtualized if it can show more than a screenful — the standing invariant has
  no exception for popovers.
- Every colour through the token layer.
- Renderer tests in `tests/renderer/`.

## Notes

**D5**, and the M4 scope line "play-next overlay". Deliberately the smaller surface: M5's
Tunedeck (**D15**) owns the real editor, and building it twice is the failure mode this card
exists to avoid.

## What was built

`src/renderer/playback/queueCommands.ts` — five verbs (`playNext`, `addToQueue`, `remove`,
`clear`, `jumpTo`) over `upNextQueue`, with no Pinia, no DOM and no `AudioEngine` under them.
`stores/queueCommands.ts` is the single place they are bolted to the real controller and the
real IPC, so W7-2 inherits the wiring as well as the module — there is no second set of
dependencies to keep in step. The menu wording lives there too (`queueCommandLabel`), which is
why the library's menu and the pane's cannot word "Play 4,312 tracks next" differently.

- **A verb takes a `QueueTarget`, not a `Track[]`.** A right-click on one loaded row is
  holding that row; a multi-select is holding *ids*, because the list resolves a selection
  through main precisely so it never has to keep the rows for one — and the queue stores
  display snapshots (§5's `QueueEntry.track`). `queueRows` and `queueIds` let each call site
  hand over what it actually has, and neither pays for a round trip it did not need.
- **New IPC: `library.getTracksByIds`.** There was no verb that widened an id list into rows —
  `orderTrackIds` decides a *sequence* for a set with none, this widens a sequence somebody
  already has. Capped at `MAX_TRACK_PAGE` rather than `MAX_ORDERED_TRACK_IDS`, because the
  ceiling belongs to the width of the response and not to the size of a selection; the command
  chunks against it. Implemented as the public face of `hydrateTracks`, which every paged read
  already goes through, so it drops deleted ids and repeats a repeated one — the second
  mattering because D12 makes one track legal twice in a queue.
- **Order is preserved by construction.** The chunks are sequential and concatenated in
  request order. Racing them would settle the acceptance criterion by whichever query finished
  first; the test drives a 4,000-row descending selection through 40 chunks to prove it.
- **Queueing from the playlist pane crosses back to track identity.**
  `resolveSelectedTracks` walks `listEntries` once, stopping as soon as the selection is
  accounted for. Entry ids never reach the queue — the queue holds track ids so deleting the
  playlist a row came from cannot touch it (§5 rule 4), and the entry id is the one identity
  that could.
- **The overlay is virtualized, with `listViewport.ts` and nothing else.** The queue is
  already in memory, so there are no pages to fetch, nothing to evict and no ordering
  generation — what is left of `trackWindow` is arithmetic, which is the part worth testing
  without a browser. Two spacers rather than absolute positioning, so rows stay in normal flow
  and the scrollbar is the real one.
- **The count is on the transport, not in the popover.** A non-empty queue changes what Next
  does. The badge carries the number and the button's label says it in words, so the state is
  not colour-only.

No reordering in the overlay, as the card allows. Every colour is a token
(`primary`, `text-muted`, `text-dimmed`, `border-default`); nothing is hardcoded.

## Verification

`lint`, `format:check`, `typecheck`, `test`, `build` all green. 784 tests pass, 21 new.

- `tests/renderer/playback/queueCommands.test.ts` — driven against the **real** `upNextQueue`
  rather than a mock of it, because the thing worth checking is the composition. Visible order
  across 40 chunks, play-next landing in front of what is queued, rows-in-hand skipping the
  round trip entirely, survivors when ids are gone, two copies of one track as two rows, and
  jump-to-entry taking only the row it plays.
- `tests/renderer/panels/listViewport.test.ts` — the bound is the viewport and never the list;
  the spacers plus the drawn rows always account for the full scroll height.
- `tests/main/library/trackIds.test.ts` and `tests/main/ipc/validate.test.ts` — the new verb's
  order preservation, duplicate repetition, dropped ids, and its ceiling.

**Driven in the running app** over CDP: a four-row library multi-select queued from the row
menu (`Add 4 tracks to queue`), the transport badge and its label following the count, the
overlay opening with the four rows in the selection's visible order, one row removed with the
rest renumbering, `Clear` emptying it, and the same two verbs appearing and working from the
playlist contents pane's menu — which is the path that exercises `resolveSelectedTracks`.

## Still owed

- **Jump-to-entry was not driven live**, only unit-tested, because clicking it starts audio on
  the operator's machine. Worth a click during the W5-8 gate run.
- The overlay has no reordering, per the card. W7-2 adds it with the deck pane.
