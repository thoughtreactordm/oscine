---
taskId: 01KYTKYEBY8CPQ08PBS15WGN9R
title: MusicBrainz artist resolution and the correction UI (R5)
status: todo
priority: high
labels:
  - M7
  - phase-2
  - risk
workstream: W7
workstreamId: W7-9
dependsOn:
  - 01KYTKY47ZVSMKATN8RQ774AZ4
order: 14
created: '2026-07-30T22:57:27.421Z'
updated: '2026-07-30T22:57:27.421Z'
---
## Scope

- Implements **R5**. Search MusicBrainz by artist name, accept a match only above a score threshold.
- Migration adding an MBID column to the `artists` row, so a match is made once per artist rather than once per play.
- The "not this artist?" affordance in the deck header, opening a disambiguation picker. The operator's choice is authoritative and persists — the same shape as **D7**'s treatment of tag corrections.

## Acceptance

- Correct resolution across a fixture set chosen to be hard, not easy: an ambiguous name (the "Nirvana" case), one with punctuation, one non-Latin, one carrying a featured-artist string, and one that genuinely does not exist in MusicBrainz.
- Unresolved renders as a first-class state with every local pane intact.
- An operator correction survives restart and is never silently overwritten by a later automatic match.
- The threshold value is documented with the reasoning behind it.

## Notes

**R5** is the correctness risk of this entire workstream. A confident, wrong biography is worse than no biography — which is why the threshold must be tuned against the whole fixture set rather than against whichever artist happened to be playing during development.
