---
taskId: 01KYTKWGS08GKKM5P6HR53HFMK
title: Tunedeck shell — drawer host and panel island
status: in-review
priority: high
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-1
order: 0
created: '2026-07-30T22:56:24.351Z'
updated: '2026-08-02T13:42:55.077Z'
---
## Scope

- New panel island `src/renderer/panels/Tunedeck.vue`, opened from the placeholder button already sitting in `NowPlaying.vue:255`.
- Hosted in a `UDrawer` on the right: full height, resizable by drag, **pushes** the app content rather than covering it.
- Open/closed state and width in a Pinia store, persisted across restarts.
- A pane registry, so panes are independent components the shell merely arranges. Adding a pane must not require editing the shell.
- This card ships the shell plus one trivial pane, to prove the seam. No real panes.

## Acceptance

- The NowPlaying button opens and closes the deck; open state and width survive a reload.
- The track list stays scrollable and interactive with the deck open at any width — content is displaced, not occluded.
- Deck content imports nothing from `NowPlaying` or `TrackList`, and vice versa. Reviewed against **D4** and **D15**.
- Drag-resize is clamped to a stated min/max and holds frame budget while dragging.
- Zero colour literals anywhere in the new components — everything through the token layer.

## Notes

**D15**. The `UDrawer` is the host, not the feature. The pane arrangement must survive being reparented into a dock pane when the docking system lands, which is the whole reason the content is an island rather than drawer-shaped markup.

---

## Built — `50313e5`

The one deviation from the scope, stated first: **there is no `UDrawer`**. D15
names it as the deck's *first* host, and it cannot be even that. Nuxt UI's
drawer wraps vaul-vue: the content is `fixed`, portalled to the body, and comes
with a `fixed inset-0` overlay. It occludes by construction, which is the
arrangement D15 lists under rejected alternatives — "a modal covering the
content (simplest, and useless for browsing alongside)". Two acceptance criteria
here say the same thing from the other side: content is displaced not occluded,
and the drag is clamped to a stated min/max, where vaul's drag dismisses. The
deck is a sibling in the shell row instead, sized by the same `PaneResizer` the
sidebar and the Sources split use. Every behavioural clause of D15 holds; only
the named component does not.

### Decisions worth knowing about

- **The frame nests, so the reserves stay honest.** Sidebar and body moved one
  level deeper and the deck sits outside them. `PaneResizer` measures its own
  parent, so the sidebar's handle now measures a row the deck has been removed
  from and `SIDEBAR_PANE.reserve` remains exactly the body's `min-w-120`. There
  is no static number that is right for both panes at once — whichever one owns
  the outer row has to reserve for the other's *minimum* rather than its current
  size — and the deck was given that job because it is the transient one.
- **The deck's spec lives with the deck, not in `shellLayout.ts`.** That is where
  `SOURCES_ARTISTS_PANE` sits, and the deck is deliberately the exception: it is
  the one island D15 says will be reparented, and a dock host adopting it needs
  the bounds and the pane list and nothing else.
- **The width is one entry in `view.shellPaneSizes`, not a key of its own.** The
  record shape W8-3 chose exists for exactly this: a pane's default, minimum and
  reserve are stated once in its `PaneSpec`, and a scalar descriptor would
  restate two of them somewhere they could disagree.
- **`side: 'after'` is the only pane in the app that has it.** The deck sits to
  the right of its handle, so the drag that grows it moves left. Nothing else
  would have caught a sign error — the other two panes both sit before theirs —
  so it has its own test.
- **Open state persists; the cover pane's does not.** An expanded cover is a
  glance. A deck that displaces the body is a layout, and finding it closed
  after a restart would be the frame undoing a decision.

### Surface

`src/renderer/panels/Tunedeck.vue` is the island: a header, a scrolling stack,
and no knowledge of any pane. Panes come from `tunedeck/panes.ts`, which is the
only file a new pane touches; the rules live in `tunedeck/tunedeckPanes.ts`,
split out so they can be tested under a Vitest with no Vue plugin. A static list
rather than side-effecting registration calls — an import whose only purpose is
a side effect is one a bundler may drop, and a pane missing from a production
build but not a dev one would be a bad afternoon. `DeckIntroPane.vue` imports
nothing at all, which is the proof; it should be deleted by the first real pane
rather than grown into one. `NowPlaying` reaches the deck through
`stores/tunedeck` only, the same route the cover toggle takes.

### Tests

- `tests/renderer/panels/tunedeckPanes.test.ts` — registry order, `byId`,
  duplicate and blank ids, the frozen list; and the width arithmetic: clamping,
  the `after`-side drag, the reserve at the window's own `minWidth`, and the
  key not colliding with the frame's.
- `tests/shared/viewSettings.test.ts` — `view.tunedeckOpen` defaults closed and
  refuses a merely-truthy value. `'false'` is the case that matters: coercing it
  would open the deck to say the deck is closed.

### What only the app could tell us

The reserve was two pixels short. Driven in a scratch second instance on a
1261px row, a reserve of `240 + 480` stopped the drag at 541 and left the
sidebar at **238** — below the minimum its own handle refuses to cross, so being
pushed by the deck was a way round being dragged by the operator. The two
hairline handles between the three panes are real pixels; the reserve is 722 and
the sidebar now lands on exactly 240. No unit test could have found it, because
the number it was wrong by is a detail of the markup.

Also measured in the app, with 20,000 synthetic tracks and the deck at 280, 400
and 539: the list scrolls, stays at 49 DOM nodes, hit-tests clean at three
points down its middle, and overlaps the deck by zero at every width. A drag of
252 pointer moves, one per animation frame, held a 4.2ms median and a 4.9ms
p95 with no frame over 20ms. Open state and width survived a full restart, not
just a reload.

`Input.dispatchMouseEvent` turned out to cost five seconds per call against this
target, so the drag was driven in-page at one move per frame with the three
pointer-capture methods stubbed — every other part of the path, the component's
handler included, was the shipped one.

### Not done here

No real panes, per the scope. Which panes are open, and in what order, is not
persisted: there is one pane, and inventing a storage shape for an arrangement
nobody can make yet would be guessing at what the queue and signal panes need.
Verified on Linux only.
