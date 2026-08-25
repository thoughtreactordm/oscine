---
taskId: 01KZ4Q5KF9RXX2JS0YR85BAAKN
title: The artist nexus favorites annotation — a local count against a remote list
status: backlog
priority: low
labels:
  - main
  - tunedeck
  - W7-adjacent
  - D18
workstream: W10
workstreamId: W10-15
dependsOn:
  - 01KZ40M85TA043BH193Z81VD2D
order: 9
created: '2026-08-03T21:06:12.072Z'
updated: '2026-08-25T22:23:18.206Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Favorites → "As a relations parameter", second half.

**Split out of W10-9**, which landed the first half — the `FavoriteBias` parameter on `related.ts`'s six strands. That card said in as many words: *"This card depends on W7's nexus existing for part 2. If it does not yet, land part 1 and split part 2 out rather than blocking."* It does not yet. `nexus` appears nowhere in `src/` — the only occurrence in the repository is `tests/renderer/panels/tunedeckPanes.test.ts`, where it is a legacy tab id asserted to resolve to `artist` and to have no registration of its own.

**Do not start this until W7's artist nexus exists.** There is nothing here to annotate until there is a list of similar artists to annotate, and building the annotation against an imagined shape is how it ends up not fitting the real one.

**The work.** When the nexus resolves similar artists from MusicBrainz, annotate each with how many favorites the operator holds for it.

The whole character of the card is in one phrase from the spec: **computed locally against a remote list**. The list of similar artists comes from the network; the count comes from `track_favorites` joined to `tracks`. No favorite is sent anywhere, no MBID is needed to produce the number, and — the property worth testing — **the annotation is present even when the similar-artist list came from cache with the network down.** A count that vanishes offline would mean the count had been computed remotely, which is exactly the design this card exists to rule out.

Note the identity seam: MusicBrainz returns artists by MBID and name, while `track_favorites` reaches artists through `tracks.artist_id`. How a remote artist is matched to a local one is the real problem in this card and it is not solved by W10-9. Whatever the answer, an artist that cannot be matched should annotate as **zero rather than as absent** — "you have no favorites by them" is a true and useful thing to say, and it is the same thing the operator sees for an artist they genuinely have none by.

**Done when:** the nexus shows a favorites count against each similar artist, and it still shows it with the network unplugged.
