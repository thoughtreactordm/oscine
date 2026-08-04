---
taskId: 01KZ40NGY6GCWYGQSSSBE5QTJ7
title: The Listening dashboard — a new Sources destination
status: in-review
priority: medium
labels:
  - ui
  - stats
  - W4-adjacent
workstream: W10
workstreamId: W10-12
dependsOn:
  - 01KZ40MRD5Z3CW0GE4NMVWPX02
order: 1
created: '2026-08-03T14:32:56.518Z'
updated: '2026-08-03T22:42:43.329Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → The stats engine → "The dashboard".

A new top-level destination in `Sources.vue`, alongside Library and Podcasts.

**It is a dashboard, not a retrospective.** It answers "what have I been listening to" at any moment, rather than performing a year for you once in December. The Wrapped-style thing is W10-14 and is deliberately a separate, unspecified card — folding narrative and presentation problems into this one would produce something that is neither.

**Contents:**
- A time-range selector: 7 days / 30 days / 90 days / this year / all time. Persisted as a `view`-scoped setting (W8), because it is machine-local session state that must not pay an IPC round trip.
- Headline totals from `stats.summary` — listens, time listened, distinct tracks/artists.
- Top tracks / albums / artists / genres as four ranked lists, each showing both totals, each clicking through to the library. Rows whose track is gone render as plain text rather than a dead link — `track_id` is nullable by design (D17).
- Listening over time from `stats.overTime`, bucketed to suit the range.

**Constraints that are not negotiable here:**
- **Virtualized from the first commit** if any list can exceed a screen. The invariant has no exceptions and is never retrofitted.
- **Theming through the token layer only.** No hardcoded colours — this is the kind of surface that tempts them most, and M5's exit criterion is that swapping a theme touches zero component code.
- Panels are islands: the dashboard makes no assumptions about its neighbours.

If the over-time series needs a chart, the charting choice is a decision worth making explicitly and recording — do not let a library land here by accident, and prefer inline SVG over a dependency if the shape is simple.

**Done when:** the dashboard renders correctly against an empty log (a genuine first-run state, and it should invite rather than apologise), against a week of listening, and against the large generated fixture from W10-10 inside frame budget.
