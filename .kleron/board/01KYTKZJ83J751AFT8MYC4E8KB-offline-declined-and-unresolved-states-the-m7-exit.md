---
taskId: 01KYTKZJ83J751AFT8MYC4E8KB
title: 'Offline, declined and unresolved states — the M7 exit proof'
status: todo
priority: high
labels:
  - M7
  - phase-2
  - gate
workstream: W7
workstreamId: W7-14
dependsOn:
  - 01KYTKYN1S3G4TA8FVVGFSR0BE
  - 01KYTKYWAWS1QFNZ04QR73XX0K
  - 01KYTKZ2FFXMBHX7JQEST0SVG3
  - 01KYTKZ93BBNWDPQDGQVP2RCGC
order: 19
created: '2026-07-30T22:58:04.161Z'
updated: '2026-07-30T22:58:04.161Z'
---
## Scope

- The tested proof of **D14**'s third rule: the deck is fully functional with networking declined.
- Every phase-2 pane needs a defined appearance in four states: consent declined, consent granted but offline, resolved but not yet fetched, and unresolved.
- A probe script in the shape of the existing milestone gates, producing a report rather than a checklist.

## Acceptance

- All four states are reachable in tests for every phase-2 pane, with a designed appearance in each.
- Nothing spins forever. Every loading state has a terminal outcome.
- A full airplane-mode session produces no error dialogs.
- The phase-1 local panes are pixel-identical across all four states — that is what "the deck works without the network" has to mean concretely.
- Probe runs on Windows and Linux from the same commit, per the existing gate convention.

## Notes

Written as its own card rather than folded into each pane deliberately. This is the card where "offline is a tested state, not an error path" either becomes true, or quietly doesn't and nobody notices until someone opens the app on a train.
