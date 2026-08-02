---
taskId: 01KYTKWQXSGY1WM6S56T16ZK3D
title: Up-next queue pane
status: in-review
priority: high
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-2
workstreamDependsOn:
  - W5
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
  - 01KYTWS0VXNMWQFQE9PC4X31CR
  - 01KYTWSJ58G18FTT4B7292NFYW
order: 1
created: '2026-07-30T22:56:31.672Z'
updated: '2026-08-02T14:19:22.165Z'
---
## Scope

- The first visible surface for **D5**'s transient up-next queue, which today has none anywhere in the app.
- Drag to reorder, remove an entry, clear the queue, jump to an entry.
- Visually distinguishes queued entries from the playing playlist's natural upcoming order — they are different things and §5 treats them differently.
- Virtualized from the first commit.

## Acceptance

- All seven §5 queue rules are observable through this pane, not merely implemented beneath it.
- Reorder writes fractional positions rather than renumbering.
- Removing the currently-playing entry behaves exactly as §5 specifies, with a test.
- Virtualized list, per the standing invariant — no version of this pane renders the full queue.
- Renderer tests in `tests/renderer/`.

## Notes

**D5** and the seven rules in §5. Blocked on W5's queue model existing. This is the pane that justifies the drawer's existence — if only one phase-1 pane ships, it is this one.

---

## Built — `8bc6c8c`

Two acceptance criteria could not be met as written, both because the queue
they were written against is not the queue W5-5 built. Stated first.

**"Reorder writes fractional positions rather than renumbering" does not
apply.** Fractional positions exist so that moving one row of a persisted list
does not rewrite the N rows after it in SQLite. The up-next queue has no
positions and no database: it is a `shallowRef` holding an immutable array
(§5 rule 5 — it is not persisted at all), and every operation on it already
replaces that array whole. There is nothing to renumber and nowhere to write a
position to. `move(id, toIndex)` splices, which is not a cheaper renumber but
the absence of one. If the queue is ever persisted, this criterion comes back
with it, and the revisit trigger is the same one rule 5 carries.

**"Removing the currently-playing entry" is not a gesture this pane can
offer,** because there is no such row to remove. Rule 1's shift happens when
the advance commits, so by the time an entry is audible it is out of the queue
— `take` for an ordinary advance, `takeThrough` for a jump. The pane lists what
is still to come and the playing row is `NowPlaying`'s. That is tested rather
than asserted: `upNextRows.test.ts` drives the real queue through both shifts
and checks the entry is absent from the rows, that what is left renumbers from
one, and that a jump to a session entry takes the session rows above it while
leaving the user tier standing.

### It replaced two things rather than adding a third

The pane is `tunedeck/UpNextPane.vue`, and it is also **the body of the
play-next overlay**. W5-7 built that overlay and said this card would replace
it; making it a replacement rather than an addition is the point. There is now
one virtualized queue list, one set of tier labels and one reorder gesture in
the app instead of two, and what the two would have drifted on is §5 wording.
`UpNextOverlay.vue` is down to a heading, a width and a height.

It is also the deck's first real pane, so `DeckIntroPane.vue` is **deleted**
rather than grown into, as W7-1 asked. Adding it changed `tunedeck/panes.ts`
and no file that arranges panes, which is what that card's seam was for.

### The four rules that got a mark on screen

The criterion is that §5 is *observable here*, not merely implemented
underneath, so the pane says four of the rules out loud:

- **Rule 1** — the head carries a **"Next"** badge. The queue winning over the
  playing playlist's own upcoming order is the whole of the first arm, and with
  no badge it is a claim the operator has to take on trust.
- **Rules 3 and 6** — the two tiers are labelled and counted separately, and
  the session header reads **"shuffled"** when it is. Driven live: playing from
  the library left the 599-row user tier untouched and replaced the session
  tier with 3,999 rows; toggling shuffle refilled the session tier
  (`Ash Anchor 2626 …` → `Juniper Threshold 3724 …`) and moved nothing in the
  user tier.
- **Rule 7** — repeat-one **withdraws** the Next badge and says why. This is the
  rule with no other symptom: the queue otherwise sits there looking exactly as
  it does when it is about to play, and does not.
- **Rule 5** — the footnote. A queue that will not survive a restart is
  indistinguishable from one that will until the restart, and rule 5 is a
  decision rather than an omission.

Rules 2 and 4 are visible as things that do *not* happen, so there is nothing
to draw for them.

### Decisions worth knowing about

- **A cross-tier drop is refused, not clamped.** `UpNextQueue.move` clamps to
  the mover's own tier, so a drop drawn across the boundary would land somewhere
  other than where the indicator promised — a hand-queued row dropped into the
  middle of a 300-row scope would quietly go back to the bottom of the user
  tier. `queueDestination` returns null across the boundary, so the indicator
  never draws there. The drag is still *claimed*, so it does not fall through to
  a listener that would read it as something else.
- **Rows are built from the queue's global order, not from the two tier
  projections.** `index` has to be an index into the array `move` splices;
  deriving it per-tier means adding the boundary back on at the call site, and
  getting that wrong moves a session row to the top of the session tier instead
  of where it was dropped — which looks like a working drag until the second
  tier. The tier-local number the operator counts is carried separately as
  `position`.
- **`move` joined `queueCommands` rather than being called on the store.** The
  overlay has no reorder gesture and the pane does, but the clamp is the
  queue's and a second call site that reimplemented it is the drift that module
  exists to prevent.
- **`insertionIndex` came out of `playlistReorder`.** The rail, the tab strip
  and now the queue all splice the moved row out before splicing it back in, so
  the off-by-one is one function rather than three copies. It takes indices
  rather than ids because `dragover` fires continuously and the pane already
  knows both — an id-searching variant would scan a few thousand session rows
  twice a frame for an answer the caller was holding.
- **Tier labels are rows.** One scroll container and one set of virtualization
  arithmetic over both tiers, rather than two containers with two scroll
  positions to reconcile.
- **The rows are built "on change of origin", not "user rows then session
  rows".** It describes the array it was handed instead of restating the
  invariant that array is supposed to hold; interleaved tiers would be labelled
  honestly rather than mislabelled.

### Tests

- `tests/renderer/panels/upNextRows.test.ts` — 18 tests, driven against the
  **real** `createUpNextQueue` wherever the claim is about the two composing.
  Tier labelling and counts, the empty-tier and empty-queue cases, per-tier
  numbering against global indices, the Next mark, the splice-adjusted drop
  index, the four refusals (self, own gap, cross-tier, absent row), a real
  reorder landing where the indicator said, an abandoned gesture, a row removed
  mid-gesture, and the three "row the pane never draws" cases.
- `tests/renderer/playback/queueCommands.test.ts` — `move` through the command
  module, including the clamp the pane refuses in front of.

### What only the app could tell us

Driven over CDP in a scratch second instance against a 4,000-track synthetic
library, so the operator's dev app and library were untouched.

- **Virtualization holds.** 600 hand-queued rows: 22 `<li>` in the DOM, flat at
  0, 2,000 and 10,000 px of scroll. With the session tier loaded — 4,598 rows,
  a 143,964 px scroll height — still 22 in the deck and 10 in the popover.
- **A drag reordered.** Row 1 dropped on the lower half of row 4 drew the
  `after` edge and landed exactly there. The cross-tier drag at the boundary was
  claimed, drew no indicator, and moved nothing in either tier.
- **Remove, Clear and jump.** The row button removed one and the rest renumbered
  from one; Clear emptied 599 hand-queued rows and left all 3,999 session rows
  standing. A double-click on session row 4 removed four rows — itself and the
  three above it — which is `takeThrough`'s session arm and also closes W5-7's
  "jump-to-entry was not driven live".
- **The popover was quietly a hundred pixels too tall.** A `max-h` column gives
  its children no height to resolve against, so the pane's list took its own
  448 px ceiling inside a 332 px box and rule 5's footnote was clipped off the
  bottom — a popover that measured 384 and rendered 520. The overlay now sets a
  **definite** height, and only when there is something to show, so an empty
  queue is a 116 px popover rather than a fixed pane of nothing. No unit test
  could have found it; nothing about the markup is wrong when read.

Every colour is a token (`primary`, `text-muted`, `text-dimmed`,
`border-default`, `bg-elevated`, `--ui-primary` for the drop edge); no literal.

`lint`, `format:check`, `typecheck`, `test`, `build` all green. 1,632 tests
pass, 19 new.

### Not done here

- **No keyboard reorder.** Drag is the only way to move a row. Remove and jump
  are both reachable from the keyboard; moving one is not.
- **No auto-scroll at the edges during a drag,** so reordering across more than
  a screenful means scrolling first. That is the playlist rail's existing
  behaviour rather than something this introduces.
- Verified on Linux only.

---

## Fixed — `fd3bbf6`, reported against `8bc6c8c`

**"Drag and drop is incredibly flaky. Most drops just flat out do not work."**
It was, and the cause was geometry rather than the drag model. Worth recording
because everything above was verified and none of it caught this.

The row is 36 px. The element carrying `draggable` and the four handlers was a
`flex-1` child of a `flex items-center` row — and `items-center` does not
stretch a child, so it was **24 px, centred, with a 6 px dead band above and
below every entry**. Measured in the app by walking `elementFromPoint` down the
list: of 144 consecutive pixels, 48 hit no drag handler at all.

In those bands `dragover` reached nothing, so `preventDefault` was never called
and Chromium refused the drop outright — no drop event, no move, no feedback of
any kind. Two adjacent bands form a **12 px gutter between neighbouring rows**,
which is exactly where a hand aims when dropping *between* two rows. So a third
of the list swallowed drops, and the third it swallowed was the part people aim
at. That is the difference between "broken" and "flaky": the gesture worked
whenever the pointer happened to land in the middle 24 px.

`sideOf` had the same fault in quieter form — it split at the midpoint of the
24 px box rather than of the row the operator sees, so even a live drop decided
before/after against a boundary six pixels off from the visible one.

**The row is the drag surface now.** Rows are contiguous, so there is nowhere in
the list a drag can be that is not over exactly one of them. Re-measured: all
144 pixels hit a draggable row, and drops driven at 1 px and 35 px into a 36 px
row — both previously dead — land on the correct side of the midpoint.

Three things went with it:

- **The title is plain text, not a nested `<button>`.** A control inside the
  drag surface is one more thing that has to agree about who owns the gesture,
  and it covered most of the row. Activation moved to the row itself:
  double-click, or Enter on a focused row, which is `PlaylistRail`'s idiom.
  Verified both live, and that a jump still takes only its own row.
- **A tier label is a drop target,** resolving to "before the first entry of
  that tier" (`UpNextRow.firstId`). It is 36 px a drag can be over and the top
  of a tier is a place people aim; a label that did nothing was the same defect
  in smaller form. The indicator draws on the first entry rather than on the
  label, because that is where the row is about to go.
- **The dragged row dims a frame later.** Chromium snapshots the drag image from
  the element as the handler returns, so dimming it synchronously dimmed the
  ghost being carried rather than the row it came from.

Re-verified live afterwards, so the fix did not cost what was already working:
the cross-tier refusal still refuses and moves nothing, remove still removes
one, jump takes its own row, the footnote is still in frame, and the DOM stays
flat. Two new tests — the label's `firstId`, and a drop on a label landing at
the top of its tier. 1,634 pass.

**One thing found and left alone.** `playQueued` returns early when nothing is
playing (`position.value` is null), so a jump on a queue built before the first
Play silently does nothing. That is W5-5's controller behaviour rather than the
pane's, §5 does not speak to it, and inventing an answer here would put the
decision in the wrong file. Worth a triage card.
