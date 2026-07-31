---
taskId: 01KYTWS0VXNMWQFQE9PC4X31CR
title: Up-next queue and the seven queue-semantics rules
status: in-review
priority: urgent
labels:
  - M4
  - renderer
  - playback
workstream: W5
workstreamId: W5-5
dependsOn:
  - 01KYTWR7KRXJZ4SD5GKW1J1AKA
order: 24
created: '2026-07-31T01:31:46.940Z'
updated: '2026-07-31T02:58:05.369Z'
---
## Scope

- The transient up-next queue: an ordered list of **track ids** in the renderer, layered above
  the controller's traversal rather than inside it.
- Operations: enqueue, enqueue-next, remove, move, clear, and the shift that happens on
  advance.
- Next-track resolution becomes: queue head if non-empty, else the existing `PlayOrder`
  traversal. That single seam is where all seven rules live.
- Decode-ahead must prefetch the **queue head**, not the playing playlist's next entry.
  Otherwise the scheduler warms the wrong track and spends R1's budget doing it.
- Not persisted across restarts (rule 5). Deliberately, and with a comment saying so, because
  it will look like an oversight to whoever reads it next.

## Acceptance

- Each of the seven §5 rules has its own named test in `tests/renderer/playback/`, and the
  test name states which rule it covers. This card is where M4's exit criterion is actually
  earned; W5-8 only collects it.
- Rules 6 and 7 belong here rather than to shuffle/repeat: shuffle never reorders the queue,
  repeat-one overrides the queue, repeat-all wraps the playlist while the queue still wins.
- The model is headless — the rules are tested without instantiating an `AudioEngine`.
- The queue holds track ids, so deleting the playlist a queued track came from leaves the
  queue intact (rule 4, first half), with a test.
- Queueing changes neither `playingPlaylistId` nor the current position (rule 2), and playing
  from another playlist does not clear the queue (rule 3).

## Notes

**D5** flags this as the part most likely to grow bugs, which is why §5 is a specification and
not a sketch. Treat the seven rules as the acceptance list, in order, and do not paraphrase
them into the code — quote the rule number at each branch.

## What was built

`src/renderer/playback/upNextQueue.ts` — the rows, the operations, and `chooseSuccessor`, the
one function where both arms of rule 1 meet. Three branches, each carrying its rule number:
repeat-one-at-a-boundary, then the queue head, then `nextIndex`. Rules 6 and 7 fall out of the
order those branches sit in rather than being restated anywhere.

The scheduler and controller stopped naming a bare index and now name a **`SlotPosition`** —
an order index plus the queue entry the audible track is a detour from. That one type carries
three rules at once:

- **The anchor does not move for a queue track.** Rule 1's "the next entry after the current
  one" means the entry after the row the *detour was taken from*, so a queue track inherits
  the position it interrupted, however many play in a row. That is also rule 2's second half
  — `orderIndex` cannot move, because queueing never writes it.
- **`Successor` is a three-arm union, not an index.** Each arm resolves its track from a
  different place: `queue` carries its own row, `order` needs an `at()` lookup, `again` is
  already audible. Collapsing them would have repeat-one under a queue track resolve the
  anchor row — the wrong track — which is what `again` exists to prevent.
- **`successorNeedsTotal` widens `needsTotal`.** A queue head wins outright, so nobody has to
  ask how long the playing playlist is to find that out. The round trip is skipped rather
  than awaited and discarded, the same bargain `needsTotal` was written to strike.

Decode-ahead warms the queue head, and an *edit* re-decides an already-armed boundary through
the existing `#resolveSuccessorAgain` — otherwise "play next" would only take effect from the
track after the one the user was looking at. An add behind a queued row compares equal and
keeps the ready decode, so a queue append is never an audible risk.

**The shift happens twice, on purpose.** The transport takes the head *synchronously* before
it awaits anything, because the decode the scheduler adopts is chosen inside an await and two
fast Next presses must take two rows rather than the same one twice — the same reason the
position is written early. The scheduler takes it again when the slot is actually adopted or
promoted, which is the only advance the controller is not party to. `take` is guarded rather
than a bare `shift()`, so whichever arrives second does nothing.

Two behaviours §5 does not specify, decided here and flagged for W5-7:

- **Previous backs out of a detour to the row it interrupted**, not to the row before that.
  The queued entry has already been shifted out, so there is nothing else it could mean.
- **`playQueued` removes only the row it plays.** Dropping everything above it is the other
  plausible reading of a jump; this takes the one that destroys nothing.

Rule 5 is a comment block, not an absence: the module takes no storage, and the reason —
a queue is a statement about the next few minutes — is written where it will read as a
decision, with the revisit trigger (a session restore that restores what was *playing*).

`shallowRef`, not `ref`, for the rows. A deep ref hands back a Proxy of every `Track` it
holds, and playback deliberately keeps Vue's proxies away from values that reach the audio
path — `controller.ts` says the same thing about the engine.

## Verification

`lint`, `format:check`, `typecheck`, `test`, `build` all green. 736 tests pass.

- `tests/renderer/playback/upNextQueue.test.ts` — the **seven named rule tests**, headless.
  No `AudioEngine`, no scheduler, no `PlayOrder`; rule 1's seam is a pure function and if the
  rules could only be demonstrated through an audio graph, that is where they would live.
- `tests/renderer/playback/controller.test.ts` — the same seven numbers carried through the
  transport, plus the card's decode-ahead bullet asserted directly against engine loads
  (`[playlist entry 1]` → `[playlist entry 1, queued track]` on enqueue).

Rules 2, 3 and 4 are proved twice: structurally in the model (a queue row has exactly `id`,
`trackId`, `track` — no field that could name a playlist) and behaviourally at the controller
(`playingPlaylistId` and `orderIndex` unmoved by four consecutive edits; the queue surviving
`playFromPlaylist`, `playFromList`, `stop` and both halves of `playlistDeleted`).

## Still owed

No UI. The verbs are on the controller (`enqueue`, `enqueueNext`, `removeQueued`,
`moveQueued`, `clearQueue`, `playQueued`) with `queuedEntries`, `queuedCount` and
`playingQueueEntryId` to render from — that surface is W5-7's to import unchanged. Note for
whoever takes it: `orderIndex` is the *anchor* under a queue track, so pair it with
`playingQueueEntryId` before highlighting a row in the list.
