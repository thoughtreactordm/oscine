---
taskId: 01KYTWS0VXNMWQFQE9PC4X31CR
title: Up-next queue and the seven queue-semantics rules
status: todo
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
updated: '2026-07-31T01:31:46.940Z'
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
