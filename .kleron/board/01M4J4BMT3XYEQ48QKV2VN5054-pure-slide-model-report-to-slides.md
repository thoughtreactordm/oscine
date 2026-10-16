---
taskId: 01M4J4BMT3XYEQ48QKV2VN5054
title: Pure slide model — report to slides
status: backlog
priority: medium
labels:
  - D34.10
  - R15
  - renderer
workstream: W22
workstreamId: W22-5
dependsOn:
  - 01M4J4B35HP3K6XKHRHTSTW6QA
order: 31
created: '2026-10-10T05:25:18.274Z'
updated: '2026-10-10T05:25:18.274Z'
---
Spec: wiki `oscine-field-notes` → D34.10, R15.

A pure function `buildSlides(report: RecapReport): Slide[]` — the order, content and copy data of the Field Notes sequence. **`@renderer`-free and DOM-free** so Vitest covers it directly (relative imports, no injected globals), on the `equalizerModel` pattern.

Can start as soon as W22-3 has sketched the `RecapReport` type; it does not need the aggregates implemented.

- `Slide` is a discriminated union (intro, totals, top artists, top albums, top tracks, genres, heatmap, streak, biggest day, first heard, on repeat, devices, formats, outro). Each carries only the data its view needs.
- **Slides without data are omitted by the model**, never left for the view to hide: no imports → no device slide; no linked listens → no formats slide; a sparse year drops what it cannot fill. This is R15's main guard: an old report missing a field loses a slide rather than breaking the viewer.
- Copy that depends on data ("so far" for a partial year, singular/plural, "Built from: …") is decided here, not in templates.
- Formatting of durations and counts is in the model, so the viewer renders strings.

**Tests:** a full report yields the full sequence in order; each optional slide disappears when its data is absent; a partial year says "so far"; a single-device report has no device slide; an empty year yields intro + an empty-state outro rather than throwing.

**Done when:** the model is exhaustively unit-tested against W22-3's v1 fixture and synthetic edge reports.
