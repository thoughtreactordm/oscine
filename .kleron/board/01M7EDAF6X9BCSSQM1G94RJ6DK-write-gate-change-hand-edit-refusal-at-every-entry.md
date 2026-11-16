---
taskId: 01M7EDAF6X9BCSSQM1G94RJ6DK
title: Write-gate change + hand-edit refusal at every entry point (fields held)
status: in-review
priority: medium
labels: []
workstream: W25
workstreamId: W25-3
order: 28
created: '2026-11-15T01:32:04.700Z'
updated: '2026-11-16T20:15:15.800Z'
---
**Phase 2 — RG-3.** Executes D37 **Decision B (Decision F is amended, not dropped).** `readOnly` stops meaning "never written" and starts meaning "never hand-edited".

**Scope:**
- The four ReplayGain fields stay `readOnly: true` in the registry.
- The **write gate** in `writeback/engine.ts:308`, `writeback/service.ts:270` and `writeback/diff.ts:209` changes from "admitted **and not read-only**" to "admitted". Rows under ReplayGain keys can then enter `track_tag_overrides` — but only from the ReplayGain staging service (RG-4), never from a hand-edit.
- The **hand-edit refusal stays** at `tagFields.ts:250` (`isEditable`) and is **asserted** at the `tagOverrides.*` handlers and at MCP `stage_tag_changes`. A hand-typed gain is a loudness bug and must be refused at every entry point.
- Until their W16-16 corpus rows are green, the four fields are wrapped in `held()`.

**Amends `oscine-tag-writeback` Decision F** (see `oscine-replaygain` Decision B for the exact amended text). Record the amendment on the `oscine-tag-writeback` page as part of this card — this is the one card that reopens that decision's wording, under D37's authority, not a reopening of D7/D28.

**Tests:** the write-back engine admits a ReplayGain key coming from staging and refuses the same key from `tagOverrides.set` and from MCP.
