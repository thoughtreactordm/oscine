---
taskId: 01KYXFXFHPZCVQS71J5NNC1CXS
title: 'Discover: Apple catalogue search, charts and recommendation shelves'
status: done
priority: medium
labels:
  - D16
  - D14
  - shipped
workstream: W9
workstreamId: W9-4
order: 14
created: '2026-08-01T01:44:44.851Z'
updated: '2026-08-01T01:44:44.851Z'
---
## Scope

- Keyless Apple iTunes Search / Lookup / genre-chart client in main (`src/main/podcasts/itunes.ts`). Chart RSS entries carry no feed URL, so recommendations always finish with a lookup.
- Search, browse-by-category and recommendation shelves weighted by what the operator already follows. Subscribe still goes through the ordinary RSS path.
- Thumbnails proxied through `fermata://catalog-artwork/` so the renderer never opens a socket and `img-src` carries no remote origin.

## Acceptance

- Every outbound URL is built in main from an `http:`/`https:` allowlist; `genreId` is checked against a known-category allowlist rather than a digit test, because it is interpolated into a URL.
- One user-agent for every request Fermata makes (`FERMATA_USER_AGENT`), not a literal per call site.
- The artwork proxy re-checks the host allowlist in main rather than trusting the renderer's, and refuses a host that merely ends in the allowlisted name.

## Notes

Shipped. Its outstanding debt is W9-5, not this card.
