---
taskId: 01KZ40PGZE51G1EMF9A5ZXH2YF
title: Spec out a Wrapped-style retrospective
status: todo
priority: low
labels:
  - spec
  - stats
  - deferred
workstream: W10
workstreamId: W10-14
dependsOn:
  - 01KZ40NGY6GCWYGQSSSBE5QTJ7
order: 56
created: '2026-08-03T14:33:29.326Z'
updated: '2026-08-03T14:33:29.326Z'
---
**A specification card. Produces a wiki document, not code.**

The Listening dashboard (W10-12) answers "what have I been listening to" at any moment. A retrospective is a different artifact: it performs a period back to you, once, with a shape and an order and an ending. Folding the two together would produce something that is neither, which is why they were split.

The engine is already there — W10-10's `stats.query` over `listens` and `listen_genres` can answer everything a retrospective needs. **The unsolved problems are presentation and narrative**, and those are the ones this card is for:

- What is the unit? A year is the obvious one and also the one that makes the feature dead for eleven months. A rolling twelve months, or any operator-chosen range, is more useful and less of an event.
- What is the sequence? A retrospective is ordered — there is a first card and a last one and a reason for the order. What is Oscine's?
- What does it do about a first year with two months of data in it?
- Which numbers are actually interesting for a **local library** rather than a streaming catalogue? "Top artist" is table stakes. The ones with real character are probably local-specific: the album you played start-to-finish most, the track you skipped most while still keeping in the library, the genre that took over in March, the longest unbroken listening session, how much of the library you never touched.
- Is it shareable, and if so as what? An image export is the honest answer and it is also a whole rendering problem.
- Does it use the D11 bundle to give a cross-machine picture?

**Deliverable:** a wiki document with the same structure as `fermata-listening-and-scrobbling` — decisions with rejected alternatives, a data contract if any new one is needed, and a card breakdown. It should be able to conclude "not worth building", which is a legitimate outcome for a card like this one.

**Do not start until the dashboard has been in use long enough to know which of its numbers people actually look at.** That is the input this card is missing, and building the retrospective first would be guessing at it.
