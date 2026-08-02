---
taskId: 01KYTKXDK8F31RX58FXN5MNHJ4
title: Related-in-library pane
status: in-review
priority: medium
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-5
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 10
created: '2026-07-30T22:56:53.863Z'
updated: '2026-08-02T17:04:34.942Z'
---
## Scope

- Local relatedness only. No network in this card, in this milestone.
- Catalog relations: other albums by this artist, other tracks on this album, compilations the artist appears on.
- A weaker neighbourhood section: same genre, same year, same root folder.

## Acceptance

- Queries answer within frame budget against the synthetic 100k-track library.
- Virtualized, per the standing invariant.
- An artist with genuinely nothing related renders a deliberate empty state, not a pane that looks broken.
- Zero network calls — verifiable, since phase 1 has no network layer at all.

## Notes

The genre neighbourhood is the weak half: genre tags in a scraped library are
noisy, and this gets materially better once M3's FTS5 work lands. Build the
query behind a seam so a better one can replace it without touching the pane.

Deliberately distinct from the MusicBrainz artist-relations pane, which is a
different notion of "related" and lives in M7.

---

## Done — `cd0de7f`, `8518e7c`, `d17374f`

### Genre did not exist and had to be added

Schema v1 had no genre column and the scanner never read the tag — the only
"genre" in the codebase was the podcast category allowlist. The neighbourhood
strand had nothing to match on, so this card grew a schema change:

- Migration 10 adds `tracks.genre`, plus `idx_tracks_genre_album`,
  `idx_albums_artist` and `idx_albums_year`.
- `primaryGenre` reads the first named genre. Not split on `/` or `;` —
  `Folk/Rock` is one genre in some libraries and two in others, and a scanner
  that guesses wrong writes the wrong thing for every file it touches.
- **Operational cost:** `ADD COLUMN` leaves genre NULL for every already-indexed
  track. The operator-facing Rescan is already a full re-parse (`startScan`
  defaults `incremental` to false), so it fills genre in — but nothing does it
  automatically, and until someone rescans, the genre strand is simply absent.
  No code path special-cases that: a track with no genre is a track whose genre
  strand does not appear, which is what a file with no genre tag already did.

Genre is deliberately **not** on `Track` or in `TRACK_PROJECTION` — the query
needs it in main and the pane never shows a track's own genre.

### The seam

`main/library/related.ts` splits three ways, which is how the card's
"replaceable without touching the pane" is kept:

- `RelatedQueries` — data access. `LibraryStore.relatedQueries()` is the only
  implementation that touches SQLite; tests hand-write their own.
- `NeighbourhoodStrategy` — the weak half behind one function type.
  `tagNeighbourhood` is v1; M3's FTS5 version is a second function passed to
  `buildRelated`.
- `buildRelated` — the composition, which stays.

The catalog half is deliberately not behind the seam: "other albums by this
artist" is a fact about foreign keys, and a seam there would imply a better
version exists.

### Interpretation calls worth knowing about

- **"Same root folder" reads as the seed's *parent* directory**, not its own.
  A track's own directory is the album folder in any organised library, so a
  neighbourhood scoped to it would repeat the rows the catalog half already
  lists. Declines entirely when the path is fewer than two directories deep,
  because then the "neighbourhood" is the whole root.
- **Album rows, not track rows**, for five of the six strands — a discography
  as a track list is unreadable.
- **Double-click enqueues rather than plays.** This is a surface the operator
  reads *while* something is playing; a stray double-click that cut off the
  current track is a pane they stop opening.
- **Sections are omitted, never returned empty**, so an absent strand and a
  strand with no matches are the same thing to the pane.

### Acceptance, verified

Against a seeded 100k-track library, through the real IPC boundary (scratch
instance, CDP):

| Criterion | Result |
|---|---|
| Frame budget | **0.8 ms median, 0.9 ms p95** for the whole six-strand result |
| Virtualized | 130 logical rows → **22 DOM nodes**; spacers sum to exactly 130 × 36 |
| Deliberate empty state | A loose untagged track renders the explanatory copy with **no list at all** |
| Zero network | Structural — `getRelated` is a SQLite read; phase 1 has no network layer |

Query plans confirmed: every strand is an index seek, and the genre strand uses
`idx_tracks_genre_album` as a covering index with **no temp b-tree** for its
GROUP BY. That is what the composite index is for — a bare `(genre)` index
would collect a broad genre's tens of thousands of rows first.

`relatedScale.test.ts` holds the one-frame budget at 100k with five genres, so
the index cannot be quietly dropped or reordered.

### The synthetic seeder was not representative and is now

It wrote no genre and flat `synthetic/N.flac` paths — one directory deep — so
**two of the three neighbourhood strands could never match anything** in the
library this card's acceptance names. Now: twelve broad genres (reproducing the
low-cardinality case that makes the strand expensive) and
`artist-N/album-N/track.flac`, two deep, so a track has a parent folder to have
neighbours in.

### Tests

`tests/main/library/related.test.ts` (24) — the seam against a hand-written
`RelatedQueries` with no database, plus the SQL against a real library shaped so
every strand is distinguishable from every other.
`tests/main/library/relatedScale.test.ts` (3) — the frame budget at 100k.
`tests/renderer/panels/relatedRows.test.ts` (12) — the flattening.
Plus genre cases on `metadata.test.ts`.

Full gate green: lint, format:check, typecheck, 1745 tests across 109 files.

### Not done here

- Album rows do not navigate the browser to the album. Selecting a facet by id
  needs an id-based setter that `createFacetWindow`/`createIndexedSelection` do
  not have (`select` takes an index), and adding one is browse-machinery work
  rather than pane work.
- Multi-valued genres collapse to the first. Deliberate — see above.
