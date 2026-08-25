---
taskId: 01KZ40P09R6PGFPAS3VYPD7F1S
title: D11 — carry the listens log and favorites in the export bundle
status: backlog
priority: medium
labels:
  - D11
  - W6-adjacent
  - main
workstream: W10
workstreamId: W10-13
dependsOn:
  - 01KZ40JR89PBK931CC7W55QFMT
  - 01KZ40K4S52HJ267CZEWGD7QH1
order: 6
created: '2026-08-03T14:33:12.248Z'
updated: '2026-08-25T22:23:18.172Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Amendments → D11.

D11's amendment set its own revisit trigger — *"when a card makes `tracks.play_count` derived from `play_history` rather than a counter in its own right"* — and W10-5 fires it. This card is the revisit, and it must land the amendment text in `fermata-design` as well as the code.

**The bundle carries the `listens` log.** Carrying `play_count` while dropping its source is the incoherent option, and the amendment said so in advance. The log is also mergeable in the way the trail is not: a trail is a bounded window whose merge discards rows by accident of ordering rather than by age, while a listens log is an unbounded set of timestamped events — two machines' events genuinely interleave into a chronology that did happen.

**Merge is `INSERT OR IGNORE`** against `UNIQUE(started_at, title, artist_name)`, then `stats.rebuildCounters` (W10-5) over the merged log. **Recomputed, never added** — adding two machines' `play_count` after also merging their logs double-counts every overlapping listen.

`listen_genres` rides along with its parent rows.

**Also carried:** `track_favorites`, on the same footing as ratings — a statement about a track, resolving by recency.

**Not carried, and each for its own reason:**
- `play_history` — excluded, unchanged, for D11's original reason. Do not quietly include it because it now has a neighbour that is included.
- `scrobble_queue` — machine-local outbound state. Importing another machine's pending scrobbles would submit them a second time under whichever account *this* machine is signed into.
- `track_genres` — derived from `tracks.genre` and rebuilt on scan.
- Any credential. The Last.fm session key is in `safeStorage` precisely so it cannot end up here (D19).

**Tests:** export, then import into a database already holding an overlapping log — assert no duplicates, a correct recomputed `play_count`, and that importing the same bundle twice changes nothing. Plus: a bundle from a machine with a different root layout imports its listens intact, since snapshots make them path-independent.

**Done when:** the round trip is tested, the D11 amendment text is in the wiki design doc, and a bundle from one machine gives the other the same dashboard for the overlapping period.
