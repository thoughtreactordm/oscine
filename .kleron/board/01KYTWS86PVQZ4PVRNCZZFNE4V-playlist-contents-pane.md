---
taskId: 01KYTWS86PVQZ4PVRNCZZFNE4V
title: Playlist contents pane
status: done
priority: high
labels:
  - M4
  - ui
workstream: W5
workstreamId: W5-6
dependsOn:
  - 01KYTWRE2E1YTC09T38F48NH3S
  - 01KYTWR7KRXJZ4SD5GKW1J1AKA
order: 8
created: '2026-07-31T01:31:54.453Z'
updated: '2026-07-31T19:17:34.379Z'
---
## Scope

- The pane under the tab strip: the playlist's entries, reusing the existing virtualized
  TrackList island rather than growing a second list implementation.
- Drag to reorder, writing a fractional position for the moved row only.
- Add from the library: multi-select drag and a context-menu action, both batched into one
  call.
- Remove entries, including removing the currently-playing one.
- Duplicates render as distinct rows. Keys are `playlist_entries.id`, never `track_id`, or two
  copies of a track collapse into one row and reordering scrambles.

## Acceptance

- Virtualized from the first commit, per the standing invariant — no version of this pane
  renders every entry.
- Dropping a 5k-track multi-select is a single batched IPC call, not 5k round trips.
- A reorder writes one row; verified against the store test from W5-1 rather than assumed.
- Removing the playing entry behaves as §5 specifies, with a test.
- Sort columns are display-only here: position is the truth, and sorting the view never
  rewrites it.
- Renderer tests in `tests/renderer/panels/`.

## Notes

**D12**. The same track legitimately appearing twice is the detail that breaks naive
implementations of every operation on this pane.

## What was built

`TrackList` stopped reaching into `useTrackListStore` and now takes a **`TrackListSource`**.
That is the whole of "reuse the island rather than grow a second one": the library list and the
contents pane are the same component over different sequences, and `LibraryView` passes the
track list store while `PlaylistContents` passes the entries store. Drag and the row menu are
optional props for the same reason — a list nobody drags into binds no drag handlers rather
than carrying a set of no-ops.

- `panels/playlistEntryWindow.ts` — `createTrackWindow`'s sibling. Same page cache, same
  `createIndexedSelection`, but every id it holds is a `playlist_entries.id`. Its `orderIds`
  walks `listEntryIds` rather than asking for a new IPC verb: a playlist has exactly one
  order, so re-deriving it in SQL would be a second source of truth for the same sequence.
- `panels/playlistContents.ts` — the pane's rules, headless. Drop targeting, what a drag
  carries, and the three commands.
- `panels/trackDrag.ts` — the cargo, held beside the drag. `DataTransfer` cannot carry it: the
  payload must be written synchronously inside `dragstart` and a selection has no order until
  main puts one on it. A drag started anywhere else leaves `activeRowDrag()` null, which is
  what makes a file dragged in from a file manager visibly not ours.
- `stores/playlistEntries.ts` — the pane's IPC seam, following `viewedPlaylistId` and never
  writing it.

Four decisions a reader will want the reasons for:

- **`sort` is `null`, not a no-op setter.** `ListPlaylistEntriesQuery` has no ordering to
  give, because the order *is* the stored fractional position. `null` is what tells the list
  its headers are inert, and it is a stricter guarantee than "display-only": there is no view
  sort to rewrite anything, and a view that could re-sort would make a reorder drag
  uninterpretable — the row you dropped between two others is not between them in the stored
  order. Every header renders as the inert kind, titled "this list is in its own order".
- **Entry ids everywhere, and the fixture proves it.** The window's test playlist repeats a
  track every seventh row; selecting one copy leaves the other unselected, and a removal or a
  move sends exactly the id pointed at.
- **Adding lives on the playlists store, not the pane's.** "Add these four to Mix" is aimed
  from the library at a tab nobody is looking at, so routing it through the pane would mean
  the pane could only ever add to itself. Entry edits are *published* there
  (`entriesEdited`) and the pane subscribes — the same shape `trackList` watches
  `roots.version` with. Found by running the app: before the subscription existed, an add
  from the library updated the tab count and left the pane stale.
- **A drag from another playlist's pane is refused rather than half-accepted.** Copying it
  would need every dragged entry resolved back to a track id, and the contract has no verb
  that does it in one call — so no indicator, no drop, and a note where the refusal is.

Also hung the **m3u8 export** affordance W5-4 deliberately left unbuilt, in the pane's menu,
per-export as `PLAYLIST_PATH_STYLES` intends.

## Removing the playing entry

§5 stops playback for exactly one event — deleting the playing *playlist*, rule 4 — and
removing an entry is not it. So the track plays out, `playingPlaylistId` does not move, and
the queue is untouched. The proof is structural: `createPlaylistContents` has no dependency
through which a removal could reach the transport, and the named test asserts the call log for
removing the audible row is one call long.

The traversal then carries on against the edited playlist, which is the live-position
behaviour `playOrder.ts` settled in W5-2 ("reordering a playlist under a playing traversal
changes what the next position resolves to, exactly as a rescan does for the library. That is
the intended behaviour"). **A consequence worth a triage card rather than a silent fix:** the
anchor is a position, so after removing the playing row the next advance lands one row further
on than the row that took its place. Re-anchoring means a controller seam and a decision §5
does not make; it belongs with W5-8's findings, not folded in here.

## Verification

`lint`, `format:check`, `typecheck`, `test`, `build` all green. 763 tests pass, 27 new.

- `tests/renderer/panels/playlistEntryWindow.test.ts` — paging, the bounded window over a 10k
  playlist, duplicate identity, a 5,000-row Shift-range resolved without loading a single
  extra page, selection surviving an edit, and the absence of a sort.
- `tests/renderer/panels/playlistContents.test.ts` — drop targeting, the batch (5,000 track
  ids, one call), reorder in entry ids, the refused cross-playlist drag, and §5 rule 4.
- `tests/main/library/playlists.test.ts` — a new `writes exactly one row for a dragged
  reorder and leaves the rest byte-identical`, driving the store with the exact
  `{ at: 'after', entryId }` the pane produces. The "one row" claim is checked against the
  store rather than assumed at the pane, as the card asks.

**Driven in the running app** over CDP: the pane renders virtualized with inert headers, a
library multi-select added through the context menu, a row dragged to the top reordered and
the pane reloaded, the drop marker measured (`::before`, 2px, primary), and a four-row
selection removed. That run is what caught the stale-pane bug above and a second one: passing
Nuxt UI's `on-contextmenu` prop silently overwrote `UContextMenu`'s own handler, so the menu
never opened. The hook is bound on the cell instead, with the reason at the call site.

## Still owed

- **The library→pane drag cannot be performed today.** The gesture is implemented on both
  ends and there is no screen where both lists are visible at once — Library and Curate are
  separate routes — so the working add path is the context menu. It lights up as soon as
  docking (D4) or M5's Tunedeck puts them side by side; nothing about it is provisional.
- No playing-row indicator in the pane. The playing *tab* is marked (W5-3) and the transport
  names the track; marking the row needs `orderIndex` paired with `playingQueueEntryId`, which
  is W5-7's vocabulary.
