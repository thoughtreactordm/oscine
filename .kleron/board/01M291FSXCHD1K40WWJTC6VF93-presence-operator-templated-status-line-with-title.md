---
taskId: 01M291FSXCHD1K40WWJTC6VF93
title: 'Presence: operator-templated status line with {title}/{artist} tokens'
status: done
priority: medium
labels:
  - discord
  - settings
  - main
workstream: W20
workstreamId: W20-6
dependsOn:
  - 01M28SE04CRPRVTV15AWEZQ4Q2
order: 8
created: '2026-09-11T20:10:35.306Z'
updated: '2026-09-11T22:38:18.753Z'
---
## Intent

Let the operator customise the compact Discord status line — the "Listening to X" text under their name — with a template string carrying tokens like `{title}`, `{artist}`, `{album}`, `{albumArtist}`. Requested in-conversation while reviewing W20-4.

## Why this is not just a `status_display_type` toggle

W20-4 made the status line show the song by setting `status_display_type = 2` (details) so the line mirrors the `details` field. Discord's `status_display_type` (discord-api-docs#7674) can only *point at* an existing activity field — `name`, `state`, or `details` — so arbitrary templated text (e.g. `{artist} — {title}`) cannot be dropped straight into the status line. The template must **render into a field** (`details`), and `status_display_type` keeps pointing the status line there. That seam is already in place in `activity.ts`.

## Scope

- A `discord.statusTemplate` setting (string, `category: 'network'`, `portable: false`), default `{title}`. Descriptor + generated UI + validation land via the W20-3 settings surface — hence the dependency.
- A small pure token renderer (in `src/main/discord/`, unit-tested like `buildActivity`): substitute known tokens from `PresenceTrack`, blank/strip unknown tokens, collapse the empties a missing `{album}` leaves, cap length. Wire its output into `details` in `activity.ts`.
- Privacy: `generic` display mode **ignores the template** and forces the app-name status line, so no token can leak title/artist at the privacy floor. The template is meaningful only in the `title-*` modes.

## Out of scope

Not the display-detail privacy dial (that stays as the coarse lever). No markdown/HTML in the template. No per-field template beyond the status line unless it falls out naturally.
