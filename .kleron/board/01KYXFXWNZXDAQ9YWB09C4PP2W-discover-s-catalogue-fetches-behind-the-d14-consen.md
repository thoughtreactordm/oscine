---
taskId: 01KYXFXWNZXDAQ9YWB09C4PP2W
title: Discover's catalogue fetches behind the D14 consent gate
status: todo
priority: high
labels:
  - D14
  - privacy
  - M7
workstream: W9
workstreamId: W9-5
dependsOn:
  - 01KYTKXNGSRRBNQEF2W1SY93P3
order: 42
created: '2026-08-01T01:44:58.300Z'
updated: '2026-08-01T01:44:58.300Z'
---
## Scope

**D14**'s first rule says nothing is fetched until the operator accepts a one-time prompt naming the services. Discover shipped ahead of that prompt: opening the tab calls `loadRecommendations()`, which reaches `itunes.apple.com` before the operator has agreed to anything, and the thumbnail proxy then reaches Apple's CDN on their behalf. This card closes that.

- Bring Apple's catalogue under the same consent gate W7-6 builds for MusicBrainz and Wikipedia, and name it in the prompt's copy.
- Declined must leave the Podcasts view fully usable: subscriptions, refresh, downloads and playback are all operator-named hosts and none of them are Discover. Only the Discover tab degrades, and it degrades to an explanation with a way to enable, not to an error.
- The `catalog-artwork` proxy route refuses to fetch while consent is absent — the gate belongs in main, at the socket, not in the pane that decides whether to render an `<img>`.

## Acceptance

- With consent never granted, a packet capture across a full session that includes opening the Discover tab shows zero requests to any Apple host.
- Subscribing to a feed pasted by the operator is unaffected by the gate's state; this is the distinction the prompt copy has to make correctly, because a gate that also blocks the thing the operator explicitly asked for reads as broken.
- Re-enabling takes effect without a restart.

## Notes

The second and third of D14's rules already hold: every request issues from main, and the renderer opens no socket — catalogue thumbnails go through `oscine://catalog-artwork/` rather than Apple's CDN, so `img-src` carries no remote origin. It is only the consent rule that is outstanding.

Blocked on W7-6, which owns the prompt and the setting. Recorded rather than built at the time so that podcasts do not grow a second, parallel consent mechanism that W7-6 then has to absorb.
