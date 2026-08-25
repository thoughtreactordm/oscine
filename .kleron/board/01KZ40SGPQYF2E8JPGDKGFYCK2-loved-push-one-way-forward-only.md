---
taskId: 01KZ40SGPQYF2E8JPGDKGFYCK2
title: 'Loved push — one-way, forward-only'
status: done
priority: medium
labels:
  - main
  - network
  - D18
  - D19
workstream: W11
workstreamId: W11-6
dependsOn:
  - 01KZ40S3HZGRXD8F0ZXJ3G00WE
order: 3
created: '2026-08-03T14:35:07.351Z'
updated: '2026-08-04T15:06:58.855Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Favorites → "Loved sync is one-way and forward-only".

Hearting a track in Oscine also loves it on Last.fm. The direction and the boundaries are the whole card.

**In scope:**
- Favoriting enqueues a `kind = 'love'` row; un-favoriting enqueues `kind = 'unlove'`. Through the same outbox as scrobbles, so it inherits persistence, backoff and ordering for free rather than growing a second retry path.
- Gated on a durable `lastfm.loveOnFavorite` setting, default **on** when an account is connected.
- No account connected → favoriting is purely local and enqueues nothing, exactly as it behaves today.

**Explicitly out of scope, and each for a reason:**
- **Nothing retroactive.** Connecting an account pushes none of the favorites that already exist. A retroactive bulk push would be thousands of writes to someone else's account on the strength of a single click. An operator who wants it can ask for it explicitly later, and that would be its own card with its own confirmation.
- **Nothing is read in.** Last.fm's loved tracks never become Oscine favorites. `track_favorites` is authoritative and local (D18); a two-way sync needs a conflict rule, and there is no right one for "loved there, un-hearted here".

**Ordering matters within the outbox.** Heart, un-heart, heart again in quick succession must not arrive as un-heart last. Ordering by `timestamp` ascending handles it as long as love and unlove rows for the same track are never reordered relative to each other or coalesced by a well-meaning optimisation. If you do collapse redundant pairs, collapse to the *final* state and test the three-flip case.

**Tests:** toggle on/off/on enqueues three rows and settles to loved; with the setting off, favoriting enqueues nothing; with no account, favoriting enqueues nothing; connecting an account with 500 existing favorites enqueues nothing; a love row for a since-deleted track still submits from its snapshot.
