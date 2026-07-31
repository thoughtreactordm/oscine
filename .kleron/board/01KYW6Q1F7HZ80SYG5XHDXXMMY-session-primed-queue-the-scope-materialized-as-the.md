---
taskId: 01KYW6Q1F7HZ80SYG5XHDXXMMY
title: Session-primed queue — the scope materialized as the up-next tier
status: done
priority: high
labels:
  - M4
  - renderer
  - playback
workstream: W5
workstreamId: W5-10
dependsOn:
  - 01KYTWS0VXNMWQFQE9PC4X31CR
  - 01KYTWSJ58G18FTT4B7292NFYW
order: 3
created: '2026-07-31T13:44:42.213Z'
updated: '2026-07-31T19:17:34.295Z'
---
## Why

Selecting three artists and playing a song has **always** traversed only those three artists'
tracks. `LibraryView.vue:48` hands `trackList.filters` into `playFromList`, and
`createListPlayOrder` (`playOrder.ts:114`) folds them into every `at()` and into `count()` —
so the scope bounds the traversal, bounds repeat-all's wrap, and stops cleanly at its end.

None of it is visible. The traversal is lazy and query-backed, so the only up-next surface
(W5-7's overlay) renders the *explicit* queue, which is empty, while several hundred tracks sit
genuinely lined up behind the current one. The operator's reading of that is "add to queue did
not do anything", and they are not wrong about the surface.

This card materializes the scope into the queue so the lined-up tracks are rows the operator can
see, reorder and add to. §5 has been amended for it — see the *2026-07-31: the session tier*
amendment in `fermata-design`, which is the authority for everything below.

## Scope

### Two tiers

`QueueEntry` gains `origin: 'user' | 'session'`. The user tier always sorts above the session
tier, and `UpNextQueue` maintains that invariant rather than callers remembering it.

- `enqueueNext` → head of the user tier (= absolute head).
- `enqueue` → **tail of the user tier**, i.e. immediately above the session tier.
- Session fill replaces the session tier wholesale and never touches the user tier.

`enqueue` landing at the tail of the *user* tier rather than the tail of the queue is the point
of the split. Against a loaded 300-track session, an append to the true tail means "in four
hours", which makes the verb useless — and "can be added to like normal" is the requirement.

### Session fill

Hooked into `startOrder` (`controller.ts:402`), so both `playFromList` and `playFromPlaylist`
get it through one seam and neither entry point grows a second copy.

- **Library scope**: `library.listTrackIds` with the session's filters/sort/direction from
  `index + 1` (one call, `MAX_TRACK_ID_PAGE` = 10,000), permuted renderer-side under shuffle with
  the session's seed, then widened through `library.getTracksByIds` in `MAX_TRACK_PAGE` chunks.
- **Playlist**: paged `playlists.listEntries`, whose entries carry `track` already — no widen.

**No new IPC surface.** Both paths are served by verbs that already exist, which is deliberate:
the shuffle case is what would otherwise have forced one, and permuting an id array we already
hold costs nothing.

- **The fill is asynchronous and off the click path.** `startOrder` already starts audio with the
  clicked row in hand; the fill must never make a click wait on five round trips.
- **Generation-guarded.** Clicking track A then quickly track B must not land A's fill on top of
  B's session. `controller.ts` already carries `++requestToken` for exactly this shape — use it
  rather than inventing a second counter.
- **Cap: 5,000 entries.** Any realistic facet scope — a few artists, an album, a search — fits
  whole. Broad scopes truncate, and the play order carries on correctly behind the truncation
  because of the anchor rule below. State the number as a named constant with this reasoning at
  it, not as a literal.

### A session entry moves the anchor

`upNextQueue.ts:153` gives a queue successor `position: { index: from.index, queueEntryId }` — the
anchor does not move, because a queued track is a *detour* from the row it interrupted. That is
right for a user entry and **wrong for a session entry**, and getting it wrong is a real bug, not
a nicety: a session tier holding the scope's rows 1..N against an anchor still at 0 resumes at
row 1 the moment it drains, replaying the scope from its second track.

Session entries therefore carry their own `orderIndex`, and `chooseSuccessor` returns
`position: { index: entry.orderIndex, queueEntryId: entry.id }` for them. User entries keep the
existing inheritance untouched — rule 2's second half depends on it.

### The rest

- **Shuffle refills the session tier** (rule 6 as amended) and leaves the user tier alone.
  Toggling shuffle mid-session must not leave the queue showing an order that will not happen.
- **`playQueued` on a session entry** moves the anchor to that entry and drops the session entries
  above it — they are behind the operator now. On a *user* entry it keeps W5-5's decision: take
  only the row it plays, destroy nothing.
- **The transport badge** (W5-7) counts the **user tier**. A badge reading `312` after every click
  is noise, and the state it exists to make visible — "a non-empty queue changes what Next does" —
  is a statement about the tier the operator built by hand. Show session depth separately, or not
  on the badge at all.
- **The overlay renders the tiers as visibly distinct sections**, which is also what W7-2's card
  already asks its pane to do. Virtualized, per the standing invariant — the session tier is the
  first queue that can be thousands of rows.

## Acceptance

- Playing a song under a three-artist facet selection fills the up-next surface with the remaining
  scoped tracks, in the visible sort, and playing through them matches what the order alone did
  before this card. That equivalence is the test that this changed the surface and not the music.
- **A drained capped session resumes at the row after the last one materialized**, not at the
  anchor + 1. Named test, driven at the controller against a scope larger than the cap — this is
  the bug the anchor rule exists to prevent and it is invisible under any scope smaller than it.
- Five hand-queued tracks survive a click on a library row, in order, above the new session tier.
  This is rule 3 as amended and it is the failure the two-tier split exists to prevent.
- `enqueue` against a loaded session lands above the session tier, not at the true tail.
- The click path's time-to-first-audio is unchanged with the fill in place, measured, not assumed.
- Clicking two rows in fast succession leaves exactly the second row's session queued.
- Shuffle toggled mid-session refills the session tier and leaves the user tier byte-identical.
- The seven §5 rules keep their named tests in `tests/renderer/playback/`, updated to the amended
  text, with the rule number still quoted at each branch.

## Notes

**D5**, and the §5 amendment of 2026-07-31 — read it before starting; rules 1, 2, 3 and 6 all
moved and the code must not quietly disagree with the doc again.

**W5-8 asserts the seven rules by number and now has to assert the amended text.** Add this card
to its `dependsOn` — the gate should measure the finished shape rather than the shape that was
there when it was written.

**The alternative that was not taken**, recorded so it is not rediscovered as a novelty: project
the order tail through a paged `PlayOrder.slice(offset, limit)` instead of materializing.
It needs no cap and no anchor rule, because it materializes nothing, and it is what the amendment
names as the revisit path. It was passed over because the operator wanted the queue to be a real,
editable list of rows rather than a rendered view of a query. If the cap starts being hit, or if
W7-2 wants the untruncated scope, that is the road back.

**W7-2 replaces the overlay's body with the deck pane and must inherit all of this unchanged** —
the tiers, the anchor rule and the verbs. Nothing here may land in a component; it belongs in
`upNextQueue.ts`, `queueCommands.ts` and the controller, which are the three modules W7-2 imports.
