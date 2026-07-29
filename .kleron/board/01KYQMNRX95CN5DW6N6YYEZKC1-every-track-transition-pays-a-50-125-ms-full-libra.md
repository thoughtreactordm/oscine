---
taskId: 01KYQMNRX95CN5DW6N6YYEZKC1
title: Every track transition pays a 50–125 ms full-library sort query at 100k tracks
status: in-review
priority: high
labels:
  - M2
  - scale
  - from-W6-3
  - gapless
triageKind: bug
workstream: W2
workstreamId: W2-3
order: 0
created: '2026-07-29T19:12:28.513Z'
updated: '2026-07-29T16:12:00.000Z'
---
Found by the M1 exit gate (W6-3) on Windows, 2026-07-29. **Not a Windows defect** —
a scale defect that the Windows run was the first to be in a position to see,
because that machine carries the 100k synthetic root and the Linux machine's
library is 2,976 tracks. At 3k rows this costs ~1 ms and is invisible.

## What was measured

`createListPlayOrder.at(index)` (`src/renderer/playback/playOrder.ts:75`) resolves
a position with `fetchPage({ sort, direction, offset: index, limit: 1 })`. That is
the lookup `goTo` awaits, and `goTo` is what `next()` and `previous()` call. So
**every track transition blocks on this query before the decode even starts.**

Median of 5, live renderer, 102,997 tracks, `limit: 1`:

| query | ms |
|---|---|
| `durationSec desc` @ offset 0 | 50.5 |
| `durationSec desc` @ offset 1,000 | 52.9 |
| `durationSec desc` @ offset 50,000 | 115.3 |
| `durationSec desc` @ offset 102,000 | 124.7 |
| `title asc` @ offset 0 | 49.2 |
| `artist asc` @ offset 0 | 49.6 |
| `album asc` @ offset 0 | 49.1 |
| `trackNo asc` @ offset 0 | 49.8 |

Two separate costs, and it matters that they are separate:

1. **A ~50 ms floor at offset 0, on every sort column.** Fetching *one row* from
   the top of the order costs the same as fetching a hundred. That is a full sort
   of 100k rows per query — nothing is answering these from an index.
2. **A further ~2.5x from OFFSET depth**, 50 ms → 125 ms. The classic
   `LIMIT 1 OFFSET n` scan, on top of the sort.

The same figures on the Linux run's 2,976-track library were 0.8–2.3 ms, which is
why W6-2 could not have caught this.

## Why it matters

M2 is gapless. A gapless boundary cannot afford a 50–125 ms synchronous library
query in front of the decode — that is the gap, by definition, and it is well
above the ~10 ms that would pass unnoticed. The current `decodesPerTransition: 1`
that both platform runs recorded is real, but the probe never timed the query
that precedes each of those decodes.

It also caps the M1 scale target's headroom. 100k tracks is the stated target and
this is measured *at* the target, not past it.

## What is NOT affected

The UI's own click path. `playFromList` takes a fast path when the caller already
holds the row (`controller.ts:211`), and `LibraryView.vue:49` does pass `track`,
so a user clicking a row skips the lookup entirely. The probe calls
`playFromList` *without* `track`, which is why its step-4 `toPlayingMs` figures
carry the 50 ms — a harness artifact, not a user-facing cost. See the note on
W6-3's cross-platform diff.

`next()`/`previous()` have no such fast path, and those are the ones gapless runs
through.

## Suggested shape

Probably an index question before it is an architecture question — check whether
the sort columns are covered, and whether `durationSec`/`title`/`artist`/`album`
can be answered from an index rather than a sort. The flat ~50 ms across all four
columns suggests none of them currently are.

If indexing does not close it, the order needs to stop resolving positions one
row at a time on the critical path: resolve the *next* position while the current
track is still playing, which M2 needs anyway for prefetch. That turns a 125 ms
blocking cost into a background one.

Worth a regression test at 100k, since this is exactly the class of problem that
does not reproduce on a developer-sized library.

---

# Outcome — in review

The transition lookup keeps its existing renderer contract, but the main-process
query no longer sorts or projects the whole library to resolve one position.

- Migration 2 adds exact ascending/descending expression indexes for title,
  duration, and disc/track number, including nulls-last and the stable id
  tie-breaker.
- Artist and album queries now start from their case-folded dimension index and
  find tracks through the existing foreign-key indexes. Untagged rows are read as
  a separate id-ordered tail, preserving nulls-last in both directions.
- Pagination first walks only ids through covering indexes. Artist/album joins
  and the full `Track` projection run only for the requested page, not for every
  row skipped by `OFFSET`.

Median of 7 on the local 102,970-row fixture at offset 95,000, `limit: 1`:

| query family | before | after |
|---|---:|---:|
| title / duration / track number | 43–52 ms | 0.33–0.96 ms |
| artist | ~40 ms | 6.75–6.78 ms |
| album | ~89 ms | 8.50–8.63 ms |

The new 100k regression exercises all five columns in both directions at a deep
offset. Migration-from-v1, joined-sort ties, root scoping, null-tail boundary
pages, and nulls-last in both directions are covered separately.

Verification: 236 tests, both TypeScript projects, ESLint, and Prettier all pass.
