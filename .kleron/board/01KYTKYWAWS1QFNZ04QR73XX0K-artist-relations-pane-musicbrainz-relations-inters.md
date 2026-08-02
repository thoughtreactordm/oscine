---
taskId: 01KYTKYWAWS1QFNZ04QR73XX0K
title: Artist relations pane — MusicBrainz relations intersected with the library
status: in-review
priority: medium
labels:
  - M7
  - phase-2
  - ui
workstream: W7
workstreamId: W7-11
dependsOn:
  - 01KYTKYEBY8CPQ08PBS15WGN9R
order: 16
created: '2026-07-30T22:57:41.723Z'
updated: '2026-08-02T22:36:58.781Z'
---
## Scope

- MusicBrainz artist-to-artist relations: members, former members, side projects, aliases, collaborations.
- Intersected against the local library, so the pane can say which of these artists you already own — and open them.

## Acceptance

- Relations render with ownership state, and owned entries navigate into the library.
- The intersection is by MBID where both sides have one, falling back to name match. Where the fallback is used, its imprecision is acknowledged in the UI rather than hidden.
- An unresolved artist shows nothing, rather than a relation graph for the wrong band.
- Cached per **D14**; relation graphs are large enough that refetching them per play is not acceptable.

## Notes

This is the pane that makes Tunedeck unlike other players, and the reason deferring last.fm is survivable: "the drummer's other band, which you own three albums by" is a better discovery surface than a taste-similarity list, and it needs no API key.

## What was built

`feat(tunedeck): the artist relations pane, MusicBrainz intersected with the library`

- `src/shared/artistRelations.ts` — six relation kinds rather than MusicBrainz's forty, with direction baked in where it changes the noun (`member` and `group` are one relationship seen from its two ends). `ArtistMatchBasis` carries how a match was made, because an identity join and a name guess are not equally trustworthy and the pane has to say so.
- `src/main/musicbrainz/relations.ts` — one lookup against `/artist/{mbid}?inc=artist-rels`, parsed defensively. Merges the several relationships MusicBrainz splits one stint across while keeping genuinely distinct stints apart. `inc` is part of the cache key so a relations-only document cannot answer a later request that also wanted `url-rels` (W7-12).
- `src/main/musicbrainz/libraryArtists.ts` — the intersection. MBID first, comparison key second, with the name fallback refused whenever the library row already carries a *different* MBID. The comparison-key index is memoised behind a `COUNT(*)/MAX(id)` fingerprint, which is exact for this table because `artists.name` is `UNIQUE`; track counts are read live so ownership is never stale.
- `src/main/musicbrainz/relationsService.ts` — assembles the two. Reads the MBID off the `artists` row, never from the request, so an unresolved artist never reaches a socket. Sorts by kind, then tense, then ownership, then name, and caps *after* sorting so truncation cannot drop an artist you own.
- Renderer: `stores/artistRelations.ts`, `panels/tunedeck/relationRows.ts` (pure, so the claims are testable without a DOM), `RelationsPane.vue`, a `Connections` group in the Artist tab whose badge counts what you *own*, and the load wired into `useDeckData` beside the biography.
- Navigation: `indexedSelection.selectOnly` (the first way into that module that starts from an id rather than an index) and `browse.revealArtist`, which clears the root and search narrowing — a reveal that respected the current predicate would silently do nothing whenever the artist sat outside it.

## Verification

Full gate green: `lint`, `format:check`, `typecheck`, `test` (2073 passing, 45 new), `build`.

Checked in the built app against a scratch instance with a synthetic 400-track library (second-instance CDP, operator's dev app untouched): the group registers and renders its idle state, a fabricated result draws the sections, counts, ownership badges and truncation notice as designed, and a double-click on an owned row cleared an active search, selected the artist and left `trackList.filters` at `{ artistIds: [283] }` on the Library tab.

The one thing deliberately not done: the artist facet pane does not *scroll* to the revealed row. The song list is correctly filtered and the row is selected, but bringing it into view would need main to report a facet's position under the current ordering, which is a new query and a bigger change than this card.
