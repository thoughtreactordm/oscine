---
taskId: 01M69GA30B2H4S1A8QHWGMVJT2
title: Stage-corrections tools and agent provenance in the write-back review
status: done
priority: medium
labels:
  - D36.5
  - D36.6
  - main
  - renderer
workstream: W24
workstreamId: W24-8
dependsOn:
  - 01M69G8T9JM6NJ7XXN3RY49M1F
  - 01M69G9J24JGZ47JZ7XPT1BRR2
order: 27
created: '2026-10-31T17:32:23.945Z'
updated: '2026-11-01T03:29:07.964Z'
---
Spec: wiki `oscine-mcp` → D36.5, D36.6.

The Stage corrections capability. Agent edits land in exactly the layers a manual edit does, and reach files only through the operator's Apply.

- **`stage_tag_changes`**: one call takes grouped fields (`overrides.set` service) and registry fields (`tagOverrides.set` service) per track or track group, validated against the W16 registry (key exists, value type, format support). Through the journal wrapper; one `library.changed`.
- **`list_staged`**: the pending diff (field, current file value, staged value), filterable to the current changeset.
- **`revert_staged`**: drops staged corrections for given tracks/fields (the existing revert services).
- **`dryRun`** and the **500-track cap** as in W24-7.
- **`tagWriteback.apply` is never exposed**, and neither is any path that writes a file. The tool description says so, and tells the agent to send the operator to the review.
- **Review provenance:** the write-back review gains an "agent" badge on rows whose current override came from a changeset, and a filter for them. Badge resolution is a join against `agent_changes` at load time, not a new column on the override tables.

**Tests:** grouped and registry fields both stage and appear in `tagWriteback.preview`; registry validation rejects a bad key, type and unsupported format; no tool reaches `TagWritebackService.apply` (asserted by spy across the whole tool set); the badge shows for agent rows and not for an operator edit made after.

**Done when:** an agent can stage a consistent album-artist fix across a few thousand tracks, the operator sees those rows badged and filterable in the review, and nothing touches a file until they click Apply.
