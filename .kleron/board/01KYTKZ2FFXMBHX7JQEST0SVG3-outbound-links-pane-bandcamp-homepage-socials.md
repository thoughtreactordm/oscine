---
taskId: 01KYTKZ2FFXMBHX7JQEST0SVG3
title: 'Outbound links pane — Bandcamp, homepage, socials'
status: backlog
priority: medium
labels:
  - M7
  - phase-2
  - ui
workstream: W7
workstreamId: W7-12
dependsOn:
  - 01KYTKYEBY8CPQ08PBS15WGN9R
order: 3
created: '2026-07-30T22:57:48.013Z'
updated: '2026-08-25T22:23:18.131Z'
---
## Scope

- MusicBrainz url-rels for the resolved artist: official homepage, Bandcamp, purchase links, socials.
- Opened in the system browser via `shell.openExternal`. Never in an in-app view.

## Acceptance

- A Bandcamp link appears for an artist who has one in MusicBrainz.
- Links open externally on both Windows and Linux.
- No in-app webview or `BrowserWindow` for third-party content, in any form.
- Unrecognised relation types degrade to a generically-labelled link rather than being dropped silently — MusicBrainz adds relation types over time.

## Notes

This is the Bandcamp story from the original braindump, and it is worth being clear about what it is: a link relation, not an integration. Bandcamp has no public API, so the alternative would be scraping, which is not on the table.
