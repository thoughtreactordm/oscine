---
taskId: 01KYECGYZEYQ1N1DDKBY5RYD1S
title: Virtualized sortable track list panel
status: in-review
priority: high
labels:
  - M1
workstream: W4
workstreamId: W4-1
dependsOn:
  - 01KYECFMPA141ZPJM8F2X54BAS
effort: high
order: 0
created: '2026-07-26T04:56:52.461Z'
updated: '2026-07-29T01:18:01.677Z'
---
The first panel island (design section 7). One flat track list — the three-pane Artist/Album/Song browse arrives at M3.

## Scope

- `TrackList` as a self-contained island under `src/renderer/panels`, making no assumptions about neighbouring panels. This is D4's whole point and the reason a docking system can land later without a rewrite.
- **Virtualized from the first commit.** The design targets 100k tracks; rendering all rows and retrofitting virtualization later means rewriting selection, scroll restoration and keyboard navigation.
- Columns: track number, title, artist, album, duration. Click-to-sort ascending/descending with a visible indicator.
- **Sort in SQL, not in the renderer.** Sorting 100k rows client-side means shipping 100k rows across IPC. Sort and paginate in the query; the panel requests windows of rows.
- Row selection with single click, and keyboard navigation with arrows plus Home/End.
- A Pinia store for panel state: sort column, direction, selection.
- Build against CSS custom-property tokens rather than hardcoded colors — D9 makes theming structural, and this panel sets the pattern every later panel copies.

## Explicitly not in scope

Shift/ctrl multi-select (M3, alongside add-to-playlist), configurable column sets (M3), grouping.

## Acceptance

- A synthetic 100k-row dataset scrolls smoothly with a flat DOM node count.
- Sorting a 100k-row library returns without perceptible delay, confirming the work happens in SQLite.
- No hardcoded color values anywhere in the component.

---

# Outcome — done

Commits `da175c7`, `d878cc5`, `7f2aef4`, `9d25d42`.

| File | |
|---|---|
| `src/renderer/panels/trackWindow.ts` | paging, eviction, sort and selection logic — no Vue components, no `window.fermata` |
| `src/renderer/panels/TrackList.vue` | the island |
| `src/renderer/stores/trackList.ts` | the Pinia store: five lines bolting the real `library.listTracks` onto the above |
| `tests/renderer/panels/trackWindow.test.ts` | 15 tests against a synthetic 100k-row source |
| `scripts/seed-synthetic-library.mjs` | 100k rows in the dev database in 0.7s |
| `scripts/cdp-eval.mjs` | evaluates expressions in the running renderer |

## Three decisions worth recording

### 1. Selection is an id *and* a position, not either one

A re-sort invalidates where a track sits but not the user's choice of it, and the M1 contract has no "where is track N under this ordering" query. So the index is dropped on a re-sort and re-adopted opportunistically when the row turns up in a loaded page; the id survives untouched.

The alternative — clearing selection on every column click — was rejected after seeing the behaviour it replaces. Toggling a column twice returns the list to its original ordering, and with the id kept the original row is highlighted again, which is what a user expects and what was measured happening (`afterRestoringOrder` below).

The same reconciliation runs in the other direction: pressing End selects a row whose page has not arrived, so the index is known and the id is not until it lands.

### 2. Cache eviction is by distance from the viewport, not by recency

An LRU cache evicts the page just scrolled past, which is precisely the page a scroll reversal needs back first. Eviction is ordered by distance from the current window instead, and pages currently on screen are never evicted however tight the budget. Ceiling is 32 pages ≈ 6,400 rows; without one, scrolling a 100k library end to end quietly retains every row it passed, which is the memory shape virtualization exists to avoid.

### 3. Responses carry the ordering they were issued under

A page request in flight when a column is clicked describes a different list. Storing it would interleave two orderings in one column of rows — the kind of defect that reads as "the list is sometimes wrong" and is near-impossible to reproduce deliberately. Stale responses are discarded, and the in-flight marker is released only by the request that owns it, so the same page number can be re-requested immediately under the new ordering. Both halves are tested; the second is the one that would have been missed, because forgetting it produces a permanently blank row rather than an error.

`MAX_TRACK_PAGE` moved from `src/main/ipc/validate.ts` into `src/shared/library.ts` for the same reason W1-3 exists: the renderer sizes its windows against the ceiling main rejects them with, and two constants that merely agree drift the first time either is tuned.

## Acceptance results — measured, not asserted

103k rows (100k synthetic + 2,991 real), driven through `cdp-eval.mjs` against the running app.

**Flat DOM node count.** Sampled at five scroll positions from top to bottom:

| Scroll position | First row | Rendered rows | Total DOM nodes |
|---|---|---|---|
| 0 | 1 | 24 | 360 |
| 25% | 25,740 | 24 | 360 |
| 50% | 51,485 | 24 | 360 |
| 75% | 77,230 | 24 | 360 |
| 100% | 102,975 | 17 | 283 |

`aria-rowcount` 102,991, scroll height 3,295,712px, 24 rows in the DOM. The bottom samples fewer rows because the overscan below the last row is clipped, which is correct.

**Sorting.** Click-to-sort, measured end to end — IPC, SQL and render — from a scroll position deep in the list:

| Click | ms to first real row | `aria-sort` | Scroll |
|---|---|---|---|
| Title | 200 (first, cold) | ascending | reset to 0 |
| Title again | 112 | descending | reset to 0 |
| Time | 61 | ascending | reset to 0 |
| Artist | 53 | ascending | reset to 0 |

The direct query measurement, `LibraryStore.listTracks` against the same database, is 50–65ms at offset 0 and 116–155ms at offset 99,800, for every sort column in both directions. The work is unambiguously in SQLite: the panel never holds more than 6,400 rows and cannot sort what it does not have.

Unicode ordering behaves: `風と記憶` sorts last ascending and first descending. Nulls-last works — the untagged 2% of the synthetic corpus lands at the bottom in both directions.

**Keyboard and selection**, driven through the real listener:

| Action | Result |
|---|---|
| Click row 1 | selected, index 1 |
| ArrowDown ×2 | index 3 |
| End | index 102,991, scrolled to the bottom |
| Home | index 1, scrollTop 0 |
| PageDown | index 12 (11-row viewport) |
| Reverse the sort | no row highlighted — the track is at the far end |
| Restore the sort | index 1, same track, re-adopted |

**No hardcoded colours.** No hex, `rgb()`, `oklch()` or numbered Tailwind colour in `TrackList.vue`. Everything resolves through the Nuxt UI semantic tokens over D9's custom properties — `bg-default`, `bg-elevated`, `text-muted`, `text-dimmed`, `text-highlighted`, `border-default`, `text-primary`, `bg-primary/10`. The per-column classes carry alignment and emphasis only.

## Known limitation for M3

There are no indexes supporting any sort column, so every page request re-sorts the whole table. At 103k rows that costs 50ms at the top of the list and ~130ms deep into it — under the interactivity threshold now and covered by row placeholders, but it does not have headroom. M3's exit criterion is a 100k library browsing *and searching* within frame budget, and the index work belongs there, with the FTS5 card, where the `ORDER BY` shape can be designed against the indexes rather than retrofitted. The `IS NULL` prefix and `COLLATE NOCASE` in the current clause are what an index would have to accommodate.

## Scope notes

- `TrackList` emits `select` and `activate` and nothing else. `LibraryView` wires `activate` to the existing W3-1 transport harness, so double-click still plays and M1's slice stays intact. The NowPlaying panel, real transport, and next/previous traversing the sort order are all W4-2 and were not started.
- `PageUp`/`PageDown` were added alongside the arrows and Home/End. Same code path, four lines, and their absence is noticeable in a list this long.
- Keyboard focus sits on the list, not on a row. A focused row is unmounted by virtualization the moment it scrolls out of view, taking the focus ring with it.
- The row height (32px) is declared in TypeScript, not CSS, because the scroll arithmetic needs the number and two declarations that must agree will not stay agreed.

## Not pushed

Still no git remote on this repository, so these are local commits — same gap W1-3 and W6-1 record.

## Note for whoever picks this up

The development database at `%APPDATA%/fermata/library.db` still holds the 100k synthetic rows. They have no files behind them and will fail to play. Remove them with `npm run seed:synthetic -- --clear`.
