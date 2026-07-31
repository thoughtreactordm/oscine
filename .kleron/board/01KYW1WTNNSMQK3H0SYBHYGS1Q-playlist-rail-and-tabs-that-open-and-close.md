---
taskId: 01KYW1WTNNSMQK3H0SYBHYGS1Q
title: 'Playlist rail, and tabs that open and close'
status: done
priority: high
labels:
  - M4
  - ui
workstream: W5
workstreamId: W5-9
dependsOn:
  - 01KYTWRE2E1YTC09T38F48NH3S
  - 01KYTWS86PVQZ4PVRNCZZFNE4V
order: 10
created: '2026-07-31T12:20:28.979Z'
updated: '2026-07-31T19:17:34.414Z'
---
## Why

W5-3 read **D5**'s "playlist tabs as the backbone" as "the tab strip *is* the list of
playlists", and drew `playlists.list` directly. That reading has one consequence nobody
wrote down: there is no such thing as a closed playlist, so the strip's `×` had to call
`remove`. A close button that deletes is not a close button, and a card labelled
`Close ${name}` that destroys the playlist is the kind of mistake that only gets found by
someone trying to use it.

`CurateSidebar` had scaffolded a rail and it was deliberately removed on the same reasoning
— "two ways to choose a playlist on one screen is one too many". That was the wrong frame.
A rail is not a second way to *choose*; it is the only place a *closed* playlist can be
seen. Neither D5 nor §5 says the strip must hold every playlist; the design doc has no text
about a rail at all, so nothing is being reopened here.

## Scope

- The rail in Curate's sidebar: every playlist, virtualized, with create, rename, delete,
  and drag to reorder `playlists.position`.
- Single click opens a tab and views it. Double click opens it **and** plays it (§5 rule 3).
- The strip becomes the *open* playlists. `×` closes. Nothing on it can delete.
- The open set persists across restarts.

## Acceptance

- Closing every tab leaves every playlist in the rail, and one click reopens any of them.
- The strip's drag reorders only the open set; the rail's writes `playlists.position`. The
  two orders are allowed to disagree.
- The rail is virtualized from its first commit, per the standing invariant.
- Colours through the token layer.
- Renderer tests in `tests/renderer/panels/`.

## What was built

Five new modules and one deletion of an idea.

- **`panels/playlistRail.ts`** — the rail's rules, headless. Rows, opening, playing,
  create, the delete prompt, reorder, and a **focus** that is a third thing separate from
  viewed and playing. A rail is a listbox: arrows move a highlight and Enter opens. If the
  arrows opened tabs, walking two hundred playlists to find one would leave two hundred
  tabs behind.
- **`panels/PlaylistRail.vue`** — virtualized with `listViewport` and nothing else, the way
  `UpNextOverlay` is. The playlists are already in memory, so there are no pages to fetch
  and what is left is arithmetic. Three marks for three facts: the glyph for playing, a dot
  for open, the row's own surface and primary edge for viewed.
- **`panels/playlistReorder.ts`** and **`panels/playlistRename.ts`** — the two things the
  rail and the strip genuinely share. `destinationIndex` moved here from `playlistTabs`
  because both lists splice-out-then-splice-in and therefore need the same index computed
  the same way; the rename model moved because "blank is a cancel, unchanged costs no round
  trip" written twice is two rules that eventually disagree.
- **`panels/playlistSession.ts`** — the persisted open set, `localStorage`, guarded, next to
  `columnLayout` and `transportPreferences`.

Four decisions a reader will want the reasons for:

- **`PlaylistTabCommands` has no `remove`.** The guarantee that the strip cannot delete is
  structural rather than a convention: there is no verb to reach. Its `Delete` key closes,
  and the destructive key now lives in the rail, where the row under the cursor *is* the
  playlist.
- **Two orders, allowed to disagree.** The rail owns `playlists.position`; the strip's drag
  moves a tab inside the open set and writes nothing persistent. The alternative — one
  order, with tabs as a filtered view of it — makes "drop this tab between those two" have
  no honest answer when unopened playlists sit between them in the rail.
- **`openIds` is renderer state and never crosses IPC.** Which playlists are open is
  workspace, not library. Ids are library-local, so a database copied between machines
  would restore tabs that mean something else — which is exactly why the tab set does not
  travel with it. §5 rule 5 is untouched: it makes the *queue* transient, and a queue is a
  statement about the next few minutes where a tab set is a statement about the work.
- **`view` is guarded to open tabs; `openTab` is the verb that opens.** The contents pane
  renders `viewed`, so a viewed playlist with no tab would be a pane the operator cannot
  navigate back to after clicking away.

Double-click plays from the top and **also opens**, because a playlist that started playing
without appearing in the strip would be one the operator can hear and cannot get to. An
empty playlist opens and does not play — there is no position 0, and going through the
motions would leave `playingPlaylistId` naming something inaudible.

`refresh` is now guarded against a concurrent second read: the rail and the strip are
islands that each ask for one on mount, neither may assume the other is on screen, and
Curate mounting both should still be one query.

## Verification

`lint`, `format:check`, `typecheck`, `test`, `build` all green. 832 tests pass, 48 new.

- `tests/renderer/panels/playlistRail.test.ts` — the three marks as three facts, opening,
  playing (including the empty-playlist guard and the open-before-play order), the delete
  prompt, reorder, and the roving tabindex.
- `tests/renderer/panels/playlistTabs.test.ts` — rewritten around the open set. The fixture
  carries a fourth playlist that is never opened, so every assertion about the strip is
  also an assertion that it is a *subset*. The regression this card exists for is asserted
  on the call log: closing logs exactly `['close']`.
- `tests/renderer/panels/playlistSession.test.ts` — the stored value is operator-writable
  and outlives an upgrade, so every case is about degrading to "no tabs open" rather than
  round-tripping.
- `tests/renderer/panels/playlistReorder.test.ts` — `destinationIndex` and the shared drag.

**A bug caught before the live run:** `isFocused` compared against `focusedId`, which is
null until someone presses an arrow — so no row carried `tabindex="0"` and the rail could
not be entered with Tab at all. `focusIndex`, which already had the viewed-then-first
fallback, is now the only thing that decides. It has its own named tests.

**Driven in the running app** over CDP against an isolated `--user-data-dir`, so the
operator's library was never opened: five playlists created from the rail's plus button
each opening their own tab; every tab closed and all five still in the rail; two reopened
by clicking; the viewed tab closed and the view falling to its neighbour; a rail drag
reordering the library with the drop indicator on the target row; a **tab** drag reordering
`[Beta, Gamma, Alpha]` to `[Gamma, Alpha, Beta]` while the rail stayed
`[Beta, Gamma, Delta, Alpha]`; four ArrowDowns moving the highlight and DOM focus while
opening nothing; Enter opening the highlighted row; Delete removing a playlist and taking
its tab with it; middle-click closing a tab; the pane header following the viewed tab; and
the stored session surviving a reload.

## Still owed

- **The delete confirmation was not driven live**, only unit-tested. It needs a playlist
  with entries or one that is playing, and the isolated probe library has no tracks. The
  dialog markup is carried over unchanged from W5-3, which was driven. Worth a click during
  the W5-8 gate run.
- **Double-click-to-play was not driven live** for the same reason, and for the reason W5-7
  left jump-to-entry undriven: it starts audio on the operator's machine.
- No export affordance on the rail. It is per-playlist and it is in the contents pane's
  menu already; hanging it here as well is a duplication nobody has asked for yet.
