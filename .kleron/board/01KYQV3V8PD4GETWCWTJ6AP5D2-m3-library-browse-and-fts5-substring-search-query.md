---
taskId: 01KYQV3V8PD4GETWCWTJ6AP5D2
title: M3 library browse and FTS5 substring-search query surface
status: done
priority: high
labels:
  - M3
  - library
  - search
  - scale
workstream: W2
workstreamId: W2-5
dependsOn:
  - 01KYECGN8JRHFBMDEBTRS9ZT1E
  - 01KYQMNRX95CN5DW6N6YYEZKC1
effort: high
order: 0
created: '2026-07-29T21:05:01.205Z'
updated: '2026-07-31T19:17:34.237Z'
---
Build the main-process query surface that M3's Artist/Album/Song browser and instant search consume. This is an M3 implementation card and is deliberately not blocked by W6-4's outstanding Windows exit evidence for M2.

## Scope

- Start every new channel and type in `src/shared`, then carry it through main, preload and renderer without exposing filesystem paths.
- Add paged artist and album facet queries with counts, stable ordering and filters for root, artist and album.
- Extend track queries so root/artist/album filters, search text, sort, direction and windowing compose in one declared query. Empty filters must preserve the current all-tracks behaviour.
- Put user-visible search through FTS5 over title, artist and album. D8 says substring search: prove a mid-token query such as `hemian` can find `Bohemian`; prefix-only matching does not satisfy the card. Migrate or rebuild the existing contentless `unicode61` index if needed.
- Keep the FTS index correct through insert, metadata update, rescan and delete. A rebuild after migration must be transactional and restart-safe.
- Design the browse/search `ORDER BY` shapes against W2-3's scale indexes rather than reintroducing full-library sorts. Use stable id tie-breakers and preserve nulls-last semantics.
- Reject malformed or unbounded queries at IPC and discard stale renderer responses when filters change rapidly.
- Add scale-focused query tests using the deterministic 100k-track seed.

## Explicitly not in scope

Foobar-style query syntax, saved searches/smart playlists, playlist CRUD, tag editing, fuzzy ranking, or online metadata.

## Acceptance

- Artist and album facets page without loading the full dimension into the renderer.
- Title, artist and album searches include true infix cases, Unicode and diacritics, and combine correctly with every browse filter and sort.
- Insert/update/delete/rescan tests prove FTS results never retain ghosts or miss current rows.
- On the 100k fixture, warm first-page browse and search queries meet a 16.7 ms p95 budget locally; deep windows remain indexed and their timings are recorded for the M3 exit gate.
- The ordinary repository gate passes on both CI platforms. Any platform difference becomes a finding, not a conditional query path.

## Outcome — in review

- Shared contracts now expose bounded artist and album facet pages plus one
  composable track query carrying root, artist, album, literal search, sort,
  direction and windowing. Main validates closed request shapes and positive
  ids; preload and renderer expose only display metadata and opaque track ids.
- Migration 4 transactionally replaces the token-oriented `unicode61` index
  with case-insensitive, diacritic-folding FTS5 trigrams. Metadata-only triggers
  maintain its contentless rows on insert, retag/rescan, direct delete and root
  cascade without reindexing ReplayGain-only updates.
- Facets count only matching tracks, page in case-folded dimension order with id
  tie-breakers, and use root/dimension indexes. Filtered track searches reduce
  through FTS and foreign-key indexes before ordering and projecting the page;
  the existing indexed all-tracks path is unchanged for empty filters.
- The renderer track window includes browse/search filters in its request
  generation, so a late response from rapid filter changes is discarded.
- Tests cover `hemian` → `Bohemian`, Unicode, diacritics, literal FTS operator
  text, every filter/sort/direction combination, facet counts/paging, migration
  rebuild, rescan replacement, delete/cascade ghosts, strict IPC validation and
  renderer stale-response rejection.

## Local verification

- Deterministic 100k fixture, warm first-page p95: tracks 2.20 ms, artists
  3.95 ms, albums 6.34 ms, true-infix search 2.64 ms.
- Warm deep windows: artist facet 4.08 ms, album facet 7.26 ms, search 9.90 ms.
- `npm test`: 30 files, 337 tests passed.
- `npm run build`, `npm run typecheck`, `npm run format:check`, targeted ESLint
  over every changed file, and project-wide ESLint with `.claude` excluded pass.
- The repository-wide `npm run lint` is currently blocked before project
  evaluation by pre-existing nested `.claude/worktrees`: ESLint detects three
  candidate TSConfig roots and emits 318 parser-root errors. CI platform
  verification remains the review step.
