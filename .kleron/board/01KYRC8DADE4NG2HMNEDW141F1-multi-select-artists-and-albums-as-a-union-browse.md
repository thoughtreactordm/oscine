---
taskId: 01KYRC8DADE4NG2HMNEDW141F1
title: Multi-select artists and albums as a union browse filter
status: todo
priority: medium
labels:
  - renderer
  - library
  - ipc
  - selection
workstream: W4
workstreamId: W4-5
order: 6
created: '2026-07-30T02:04:36.556Z'
updated: '2026-07-30T02:04:36.556Z'
---
The Artists and Albums panes select one row. Selecting several — three artists, or four
albums across two of them — is table stakes for a poweruser library, and it is also the
shape M4 needs when a facet selection becomes a playlist.

## Scope

Union filtering only. Selecting N artists narrows the song list to the union of their
tracks; the artist and album predicates still AND with each other and with the root and
the search text. Facet-level actions (right-click → queue, add to playlist) are M4's, not
this card's — there is nowhere for them to go yet.

Keyboard parity with the song list is in scope: Ctrl toggles, Shift ranges from the
anchor, Ctrl+Shift extends. A facet pane that behaved differently from the list two panes
over would be worse than no multi-select.

## The contract change

`LibraryBrowseFilters.artistId?: number` becomes `artistIds?: number[]`, likewise
`albumId`. That is the load-bearing part of this card, and it reaches:

- `buildFilter` — `IN (SELECT value FROM json_each(@artistIds))`, so one prepared
  statement shape serves every selection size rather than one per arity.
- `assertBrowseFilters` — array validation plus a hard element cap, so an IPC caller
  cannot hand SQL a hundred thousand element `IN`.
- `listTrackIds`' unfiltered fast path, which currently tests the singular fields.
- `defaultSortFor` — "inside one artist, sort by album" is true for exactly one artist.
  Two selected artists are not a discography and must not be ordered as one.
- `createListPlayOrder`'s `filterId` — needs a **sorted** join of the ids, or the same
  selection reached by clicking in a different order yields two play-order identities for
  one list.

No schema change. These are query-side predicates; schema v1 and the relative-path
invariant are untouched.

## New IPC

`library.listArtistIds` and `library.listAlbumIds`, mirroring `listTrackIds`. A Shift-range
needs the ids for an index span whose facet pages are not loaded, and resolving that from
display pages would mean retaining them — the thing the id endpoints exist to avoid.
They also make cascade pruning cheap: when the artist selection changes, the surviving
album selection is `listAlbumIds({ ...filters, artistIds, albumIds: selected })`, a query
bounded by the selection rather than by the library.

## Renderer

`createTrackSelection` is already free of Vue, IPC and the store, and its deps are plain
numeric ids — it generalizes to `createIndexedSelection` and is instantiated once per
dimension. The panes need a select hook that carries the modifier flags, which `UListbox`
does not have (its `multiple` mode is toggle-on-click and nothing else), so both panes
move to one shared virtualized `FacetList` island.

## Done when

- Selecting several artists narrows the songs to their union, and the count in each pane
  header reflects the selection.
- Ctrl, Shift and Ctrl+Shift behave as they do in the song list, including a Shift-range
  that spans facet pages never scrolled through.
- Narrowing the root or the artist set drops only the album selections that no longer
  exist, and leaves the rest selected.
- The play order for a multi-artist selection is stable across click order.
- Ordering a 100k-track library by a 500-album selection stays interactive.
