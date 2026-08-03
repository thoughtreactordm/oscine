---
taskId: 01KZ40N47XC57KPA4PZMWE2FC6
title: >-
  Tunedeck — play counts and listening time for the current track, album and
  artist
status: in-progress
priority: medium
labels:
  - ui
  - tunedeck
  - stats
workstream: W10
workstreamId: W10-11
dependsOn:
  - 01KZ40MRD5Z3CW0GE4NMVWPX02
order: 1
created: '2026-08-03T14:32:43.517Z'
updated: '2026-08-03T21:27:19.382Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → The stats engine → "In the Tunedeck".

The same engine as W10-10, scoped to what is playing: play count and total time for this track, this album and this artist, plus first-played and last-played dates.

This is the surface where the stats feel like they belong to the music rather than to a report. It goes on the deck's existing Track / Album / Artist tabs alongside what is already there — W7 recently made the Track tab name what it is describing, and these numbers slot into that framing rather than needing a tab of their own.

**Constraints:**
- Local only. Works with networking declined, like every other phase-1 deck pane.
- Reads through `stats.query` with an all-time range and a filter, not through a new bespoke query. If the engine cannot express "this one artist" cleanly, that is a signal about the engine's shape — fix it there, not here.
- The deck stands down when nothing is playing, per W7's existing behaviour.
- **A zero is a real answer**, and "0 plays" reads better than an empty panel for a track you have just added.

Format times through `displayFormat.ts` rather than a second formatter. Hours-and-minutes for anything over an hour; a "4 days of listening" figure at the artist level is the kind of number people actually enjoy, and it costs nothing.

**Done when:** playing a well-worn track shows plausible counts at all three levels, and playing a freshly-scanned one shows zeroes without any panel disappearing.
