---
taskId: 01KYTKYWAWS1QFNZ04QR73XX0K
title: Artist relations pane — MusicBrainz relations intersected with the library
status: todo
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
updated: '2026-07-30T22:57:41.723Z'
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
