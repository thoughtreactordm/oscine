---
taskId: 01M4J4B35HP3K6XKHRHTSTW6QA
title: Report schema v1 and the aggregate set
status: backlog
priority: medium
labels:
  - D34.5
  - D34.7
  - D34.8
  - R15
  - main
  - shared
workstream: W22
workstreamId: W22-3
dependsOn:
  - 01M4J4APM8SYSPCNT322MSG81G
order: 29
created: '2026-10-10T05:25:00.208Z'
updated: '2026-10-10T05:26:36.809Z'
---
Spec: wiki `oscine-field-notes` → D34.5, D34.7, D34.8, R15.

The report is what persists, and it can never be regenerated from the same inputs. Sketch the type early: W22-5 (the slide model) is written against it.

**Schema** — `RecapReport` in `src/shared/recap.ts` with `schemaVersion: 1`, `year`, `partial`, `generatedAt`, `timeZone` (host's), `sources[]` (label, row count, range, duplicates dropped) and the aggregates. Entries carry **snapshot identities** (title / artist / album / album artist), never track ids or artwork hashes.

**Aggregates, generous on purpose:**
- totals: minutes, listens, distinct tracks / artists / albums
- top 50 tracks, albums, artists, genres — **ranked by summed `ms_listened`, tiebreak listen count**
- monthly and weekly series; hour × weekday heatmap
- longest daily streak; biggest day; most-repeated track in a single day
- artists and albums first heard in the year (needs the whole log)
- per-device split
- format split (codec, bit depth, sample rate) over listens linked to a local track

Reuse `StatsStore` against the scratch connection wherever its query shape fits; add queries beside it rather than forking it.

**Time zone** — every bucket and day boundary in the host's current IANA zone; export zones are not consulted.

**Upgraders** — scaffold `upgradeRecapReport(unknown): RecapReport` with the pure step-chain pattern and a v1 identity step, so v2 is a step rather than a redesign. Unknown or newer versions are a typed failure, not a throw.

**Tests:** aggregates over a seeded scratch DB with known answers (incl. a two-device fixture and a listen that crosses midnight in the host zone vs UTC); ranking tiebreak; first-heard ignores prior-year artists; upgrader round-trips a v1 fixture. Commit the v1 fixture — it is R15's first permanent fixture.

**Done when:** `buildRecapReport(scratch, year)` returns a validated v1 report and the fixture is committed.
