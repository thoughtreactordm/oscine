---
taskId: 01KYTKYN1S3G4TA8FVVGFSR0BE
title: Artist biography pane — Wikidata to Wikipedia
status: in-review
priority: medium
labels:
  - M7
  - phase-2
  - ui
workstream: W7
workstreamId: W7-10
dependsOn:
  - 01KYTKYEBY8CPQ08PBS15WGN9R
order: 15
created: '2026-07-30T22:57:34.264Z'
updated: '2026-08-02T22:01:13.872Z'
---
## Scope

- MBID → Wikidata → Wikipedia extract, rendered as attributed text with truncation and expand, plus a link out.

## Acceptance

- Renders for a resolved artist; a missing biography is a normal empty state rather than an error.
- Attribution and licence line present, as Wikipedia's terms require.
- Use the plain-text extract endpoint, or sanitise — no unsanitised remote HTML reaches the renderer under any circumstances.
- Cached per **D14**, including the negative case where an artist has an MBID but no Wikipedia article.

## Notes

The two-hop resolution is the fiddly part: plenty of MusicBrainz artists have no Wikidata link, and plenty of Wikidata entries have no article in the user's language. Both are ordinary outcomes, not failures.
