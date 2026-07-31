---
taskId: 01KYTKXNGSRRBNQEF2W1SY93P3
title: Network consent gate and settings
status: todo
priority: high
labels:
  - M7
  - phase-2
  - privacy
workstream: W7
workstreamId: W7-6
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 11
created: '2026-07-30T22:57:01.976Z'
updated: '2026-07-30T22:57:01.976Z'
---
## Scope

- Implements **D14**'s first rule: nothing leaves the machine until the operator opens the deck and accepts a one-time prompt.
- The prompt names MusicBrainz and Wikipedia, states exactly what is sent (an artist name string), and says what is stored.
- A settings toggle to enable or disable afterwards. Declined is a persistent, respected state — not a nag.

## Acceptance

- With consent never granted, a packet capture over a full listening session shows zero requests to any external host. This is the acceptance criterion that matters; assert it rather than assuming it.
- Declining costs no local pane any function.
- Re-enabling takes effect without a restart.
- The prompt's copy is reviewed for accuracy against what the fetch layer actually sends — a consent dialog that misstates the request is worse than none.

## Notes

**D14**. First card of phase 2, because every other phase-2 card is only allowed to run behind it.
